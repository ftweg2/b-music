import asyncio
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.db import get_connection, init_db
from app.douyin.detail import DouyinAweme, DouyinMusic, DouyinUnavailable
from app.job_manager import create_job, get_job_status, list_artifacts, run_job
from app.main import app
from app.models import JobState, SourceName, StrategyMode, StrategyName
from app.profile_manager import ProfileLockedError, create_or_get_profile, lock_profile
from app.schemas import JobCreateRequest
from app.strategies.base import StrategyResult
from app.strategy_selector import select_strategy_order


AWEME_ID = "7687946506598968422"
DOUYIN_URL = f"https://www.douyin.com/jingxuan?modal_id={AWEME_ID}"


def make_settings(tmp_path) -> Settings:
    return replace(
        get_settings(),
        data_dir=tmp_path,
        db_path=tmp_path / "kernel.sqlite3",
        artifacts_dir=tmp_path / "artifacts",
        profiles_dir=tmp_path / "profiles",
    )


def douyin_request(job_id: str, profile_id: str, **overrides) -> JobCreateRequest:
    values = {
        "job_id": job_id,
        "external_owner_id": "owner",
        "profile_id": profile_id,
        "url": DOUYIN_URL,
        "strategy_mode": "force",
        "strategy": "douyin_music",
        "outputs": ["raw"],
    }
    values.update(overrides)
    return JobCreateRequest(**values)


def test_selector_uses_per_source_defaults() -> None:
    assert select_strategy_order(StrategyMode.AUTO, None, None, source=SourceName.DOUYIN) == [
        StrategyName.DOUYIN_MUSIC
    ]
    assert select_strategy_order(StrategyMode.AUTO, None, None) == [
        StrategyName.API_DASH,
        StrategyName.BROWSER_NETWORK,
        StrategyName.MSE_SOURCEBUFFER,
    ]
    # The job runner passes every registered strategy; defaults stay per source.
    registry = list(StrategyName.ALL)
    assert select_strategy_order(StrategyMode.AUTO, None, None, available_strategies=registry) == [
        StrategyName.API_DASH,
        StrategyName.BROWSER_NETWORK,
        StrategyName.MSE_SOURCEBUFFER,
    ]


@pytest.mark.parametrize(
    ("mode", "strategy", "order", "source"),
    [
        (StrategyMode.FORCE, StrategyName.DOUYIN_MUSIC, None, SourceName.BILIBILI),
        (StrategyMode.FORCE, StrategyName.API_DASH, None, SourceName.DOUYIN),
        (StrategyMode.AUTO, None, [StrategyName.DOUYIN_MUSIC, StrategyName.API_DASH], SourceName.DOUYIN),
        (StrategyMode.AUTO, None, [StrategyName.API_DASH, StrategyName.DOUYIN_MUSIC], SourceName.BILIBILI),
    ],
)
def test_selector_rejects_strategies_for_other_sources(mode, strategy, order, source) -> None:
    with pytest.raises(ValueError, match="does not support"):
        select_strategy_order(mode, strategy, order, source=source)


def test_douyin_job_does_not_take_the_bilibili_profile_lock(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    lock_profile(profile["profile_id"], "running_bilibili_job", settings)

    response = create_job(douyin_request("job_douyin", profile["profile_id"]), settings)

    assert response["status"] == JobState.QUEUED
    with get_connection(settings) as conn:
        stored = conn.execute("SELECT url FROM jobs WHERE job_id='job_douyin'").fetchone()
        active = conn.execute(
            "SELECT active_job_id FROM profiles WHERE profile_id=?", (profile["profile_id"],)
        ).fetchone()
    assert stored["url"] == f"https://www.douyin.com/video/{AWEME_ID}"
    assert active["active_job_id"] == "running_bilibili_job"


def test_bilibili_jobs_still_take_the_profile_lock(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    lock_profile(profile["profile_id"], "running_bilibili_job", settings)

    with pytest.raises(ProfileLockedError):
        create_job(
            douyin_request(
                "job_bilibili",
                profile["profile_id"],
                url="https://www.bilibili.com/video/BV1GJ411x7h7",
                strategy="api_dash",
            ),
            settings,
        )


def test_douyin_job_rejects_bilibili_strategies_before_creating_anything(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)

    with pytest.raises(ValueError, match="does not support douyin"):
        create_job(douyin_request("job_wrong_strategy", profile["profile_id"], strategy="api_dash"), settings)

    assert not (settings.artifacts_dir / "job_wrong_strategy").exists()


def test_douyin_job_auto_mode_defaults_to_douyin_music(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)

    response = create_job(
        douyin_request("job_auto", profile["profile_id"], strategy_mode="auto", strategy=None),
        settings,
    )

    assert response["status"] == JobState.QUEUED


def test_douyin_job_publishes_source_mp3_as_raw_artifact(tmp_path, monkeypatch) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    create_job(douyin_request("job_run", profile["profile_id"], strategy_mode="auto", strategy=None), settings)
    seen_urls: list[str] = []

    class FakeDouyinStrategy:
        name = "douyin_music"

        def supports(self, _context) -> bool:
            return True

        async def run(self, context) -> StrategyResult:
            seen_urls.append(context.url)
            raw_path = context.job_dir / "raw.mp3"
            raw_path.write_bytes(b"ID3-audio")
            return StrategyResult.succeeded(
                reason="ok",
                selected_media={"source": "douyin", "aweme_id": AWEME_ID, "media_kind": "music"},
                raw_artifacts=[raw_path],
                timings={"duration_ms": 1},
            )

    monkeypatch.setattr("app.job_manager.strategy_registry", lambda: {"douyin_music": FakeDouyinStrategy()})

    asyncio.run(run_job("job_run", settings))

    status = get_job_status("job_run", settings)
    assert status["status"] == JobState.SUCCEEDED, status["sanitized_error"]
    assert status["selected_strategy"] == "douyin_music"
    assert seen_urls == [f"https://www.douyin.com/video/{AWEME_ID}"]
    artifacts = {item["name"]: item for item in list_artifacts("job_run", settings)}
    assert artifacts["raw.mp3"]["type"] == "raw"
    assert artifacts["raw.mp3"]["mime_guess"] == "audio/mpeg"


def test_strategy_listing_reports_per_source_orders() -> None:
    body = TestClient(app).get("/v1/strategies").json()

    assert body["strategies"] == StrategyName.ALL
    assert body["default_order"] == ["api_dash", "browser_network", "mse_sourcebuffer"]
    assert body["source_orders"] == {
        "bilibili": ["api_dash", "browser_network", "mse_sourcebuffer"],
        "douyin": ["douyin_music"],
    }


def resolve_client(tmp_path, monkeypatch, aweme_or_error) -> tuple[TestClient, str]:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    monkeypatch.setattr("app.routers.douyin.get_settings", lambda: settings)

    async def fake_fetch(aweme_id, _settings, _raise_if_cancelled=None):
        assert aweme_id == AWEME_ID
        if isinstance(aweme_or_error, Exception):
            raise aweme_or_error
        return aweme_or_error

    monkeypatch.setattr("app.routers.douyin.fetch_aweme_detail", fake_fetch)
    return TestClient(app), profile["profile_id"]


def test_resolve_returns_public_metadata_without_media_urls(tmp_path, monkeypatch) -> None:
    aweme = DouyinAweme(
        aweme_id=AWEME_ID,
        desc="一首歌 #音乐",
        author="作者",
        duration_seconds=84,
        music=DouyinMusic(
            title="歌名",
            author="歌手",
            duration_seconds=83,
            play_urls=["https://lf3-music-east.douyinstatic.com/obj/ies-music-hj/1.mp3"],
        ),
        video_play_urls=[],
    )
    client, profile_id = resolve_client(tmp_path, monkeypatch, aweme)

    response = client.post(
        "/v1/douyin/resolve",
        json={"external_owner_id": "owner", "profile_id": profile_id, "url": DOUYIN_URL},
    )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "provider": "kernel_douyin",
        "profile_id": profile_id,
        "aweme_id": AWEME_ID,
        "source_url": f"https://www.douyin.com/video/{AWEME_ID}",
        "title": "一首歌 #音乐",
        "creator_name": "作者",
        "duration_seconds": 84,
        "music_title": "歌名",
        "music_author": "歌手",
        "has_music_audio": True,
        "has_video_audio": False,
        "has_cover": False,
    }
    assert "douyinstatic" not in response.text


def test_resolve_maps_unavailable_items_to_404(tmp_path, monkeypatch) -> None:
    error = DouyinUnavailable("DOUYIN_ITEM_UNAVAILABLE", "Douyin item is unavailable or private (core_dep)")
    client, profile_id = resolve_client(tmp_path, monkeypatch, error)

    response = client.post(
        "/v1/douyin/resolve",
        json={"external_owner_id": "owner", "profile_id": profile_id, "url": DOUYIN_URL},
    )

    assert response.status_code == 404
    assert "DOUYIN_ITEM_UNAVAILABLE" in response.json()["detail"]


def test_resolve_rejects_non_douyin_urls_and_other_owners(tmp_path, monkeypatch) -> None:
    client, profile_id = resolve_client(tmp_path, monkeypatch, DouyinUnavailable("X", "unused"))

    not_douyin = client.post(
        "/v1/douyin/resolve",
        json={"external_owner_id": "owner", "profile_id": profile_id, "url": "https://example.com/video/1"},
    )
    other_owner = client.post(
        "/v1/douyin/resolve",
        json={"external_owner_id": "someone-else", "profile_id": profile_id, "url": DOUYIN_URL},
    )

    assert not_douyin.status_code == 400
    assert other_owner.status_code == 403
