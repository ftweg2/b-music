import asyncio
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.bilibili import wbi
from app.bilibili.playurl import select_best_audio
from app.browser.page_budget import DECORATIVE_URL
from app.config import get_settings
from app.db import init_db
from app.main import app
from app.profile_manager import create_or_get_profile
from app.routers import jobs as job_routes
from app.strategies import api_dash
from app.strategies.browser_network import _has_playurl_audio_list, _wait_with_cancellation


PRIMARY = "https://upos-sz-mirrorcos.bilivideo.com/audio.m4s?deadline=1"
BACKUP = "https://upos-sz-mirrorali.bilivideo.com/audio.m4s?deadline=1"


def test_best_audio_keeps_backup_cdn_urls_in_order() -> None:
    audio = select_best_audio({"dash": {"audio": [
        {"id": 30216, "bandwidth": 67000, "baseUrl": "https://low.example/a.m4s"},
        {"id": 30280, "bandwidth": 319000, "baseUrl": PRIMARY, "backupUrl": [BACKUP, PRIMARY, 7]},
    ]}})

    assert audio.audio_id == 30280
    assert audio.urls == [PRIMARY, BACKUP]


def test_best_audio_without_backups_still_works() -> None:
    audio = select_best_audio({"dash": {"audio": [{"id": 30280, "bandwidth": 1, "base_url": PRIMARY}]}})

    assert audio.urls == [PRIMARY]


def test_download_falls_back_to_backup_cdn(tmp_path, monkeypatch) -> None:
    attempted: list[str] = []

    async def fake_download(_client, url, _headers, output_path, _settings, _cancel=None):
        attempted.append(url)
        if url == PRIMARY:
            raise httpx.ConnectError("primary CDN node unreachable")
        output_path.write_bytes(b"audio")
        return {"mode": "single_stream", "chunks": 1, "content_length": 5}

    monkeypatch.setattr(api_dash, "download_audio", fake_download)

    used, info = asyncio.run(api_dash.download_from_mirrors(None, [PRIMARY, BACKUP], {}, tmp_path / "raw.m4s", get_settings()))

    assert used == BACKUP
    assert attempted == [PRIMARY, BACKUP]
    assert info["mode"] == "single_stream"


def test_download_retries_every_mirror_once_more_before_failing(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(api_dash, "MIRROR_RETRY_DELAY_SECONDS", 0)
    attempted: list[str] = []

    async def always_failing(_client, url, _headers, _output_path, _settings, _cancel=None):
        attempted.append(url)
        raise httpx.ReadTimeout("slow CDN")

    monkeypatch.setattr(api_dash, "download_audio", always_failing)

    with pytest.raises(httpx.ReadTimeout):
        asyncio.run(api_dash.download_from_mirrors(None, [PRIMARY, BACKUP], {}, tmp_path / "raw.m4s", get_settings()))
    assert attempted == [PRIMARY, BACKUP, PRIMARY, BACKUP]


class NavClient:
    def __init__(self) -> None:
        self.calls = 0

    async def get(self, url, headers=None):
        self.calls += 1
        return httpx.Response(200, json={"data": {"wbi_img": {
            "img_url": "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
            "sub_url": "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
        }}}, request=httpx.Request("GET", url))


def test_wbi_keys_are_reused_until_they_expire(monkeypatch) -> None:
    client = NavClient()

    async def sign_twice():
        first = await wbi.sign_wbi_params(client, {"bvid": "BV1GJ411x7h7"}, "ua")
        second = await wbi.sign_wbi_params(client, {"bvid": "BV1GJ411x7h7"}, "ua")
        return first, second

    first, second = asyncio.run(sign_twice())

    assert client.calls == 1
    assert first["w_rid"] and second["w_rid"]
    monkeypatch.setattr(wbi, "WBI_KEY_TTL_SECONDS", 0.0)
    asyncio.run(wbi.get_wbi_keys(client, "ua"))
    assert client.calls == 2


class CountingPage:
    def __init__(self) -> None:
        self.waits = 0

    async def wait_for_timeout(self, _ms: int) -> None:
        self.waits += 1


class Context:
    def raise_if_cancelled(self) -> None:
        pass


def test_capture_wait_stops_once_the_audio_list_is_known() -> None:
    page = CountingPage()
    asyncio.run(_wait_with_cancellation(page, 12000, Context(), ready=lambda: page.waits >= 2))

    assert page.waits == 2


def test_capture_wait_without_ready_signal_waits_the_full_window() -> None:
    page = CountingPage()
    asyncio.run(_wait_with_cancellation(page, 12000, Context()))

    assert page.waits == 24


def test_only_the_playurl_audio_list_ends_capture_early() -> None:
    class Candidate:
        def __init__(self, reasons):
            self.reasons = reasons

    assert _has_playurl_audio_list(Candidate(["playurl_dash_audio"]))
    assert not _has_playurl_audio_list(Candidate(["audio_mp4_content_type", "media_extension"]))
    assert not _has_playurl_audio_list(None)


@pytest.mark.parametrize(
    ("url", "skipped"),
    [
        ("https://i0.hdslb.com/bfs/archive/cover.jpg@672w_378h_1c.webp", True),
        ("https://i2.hdslb.com/bfs/face/avatar.png", True),
        ("https://s1.hdslb.com/bfs/static/jinkela/long/font/HarmonyOS_Regular.woff2", True),
        ("https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/audio.m4s?e=1", False),
        ("https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1", False),
        ("https://s1.hdslb.com/bfs/static/player/main/core.js", False),
    ],
)
def test_extraction_pages_skip_only_decorative_resources(url, skipped) -> None:
    assert bool(DECORATIVE_URL.search(url)) is skipped


def kernel_client(tmp_path, monkeypatch):
    settings = replace(
        get_settings(),
        data_dir=tmp_path,
        db_path=tmp_path / "kernel.sqlite3",
        artifacts_dir=tmp_path / "artifacts",
        profiles_dir=tmp_path / "profiles",
        max_active_jobs=1,
    )
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    monkeypatch.setattr("app.routers.douyin.get_settings", lambda: settings)
    monkeypatch.setattr("app.routers.jobs.get_settings", lambda: settings)
    monkeypatch.setattr("app.job_manager.get_settings", lambda: settings)
    return TestClient(app), profile["profile_id"]


def test_douyin_lookup_waits_its_turn_behind_a_running_job(tmp_path, monkeypatch) -> None:
    client, profile_id = kernel_client(tmp_path, monkeypatch)
    monkeypatch.setattr(job_routes, "_job_tasks", {object()})

    async def must_not_run(*_args, **_kwargs):
        raise AssertionError("no browser may start while the budget is used")

    monkeypatch.setattr("app.routers.douyin.fetch_aweme_detail", must_not_run)

    response = client.post("/v1/douyin/resolve", json={
        "external_owner_id": "owner", "profile_id": profile_id,
        "url": "https://www.douyin.com/video/7687946506598968422",
    })

    assert response.status_code == 503
    assert response.headers["retry-after"] == "3"
    assert "DOUYIN_BUSY" in response.json()["detail"]


def test_jobs_wait_their_turn_behind_a_running_douyin_lookup(tmp_path, monkeypatch) -> None:
    client, profile_id = kernel_client(tmp_path, monkeypatch)

    with job_routes.lookup_admission():
        busy = client.post("/v1/jobs", json={
            "job_id": "job_while_lookup", "external_owner_id": "owner", "profile_id": profile_id,
            "url": "https://www.bilibili.com/video/BV1GJ411x7h7", "outputs": ["raw"],
        })

    assert busy.status_code == 503
    assert busy.headers["x-kernel-job-accepted"] == "false"
    assert job_routes.heavy_work_in_progress() == 0
