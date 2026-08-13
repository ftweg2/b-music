import asyncio
from dataclasses import replace

import pytest

from app.bilibili.search import _search_url, search_videos_with_profile
from app.config import get_settings
from app.db import get_connection, init_db
from app.profile_manager import create_or_get_profile


def test_search_url_includes_requested_page() -> None:
    url = _search_url("夜航星", limit=20, page=3)

    assert "page=3" in url
    assert "page_size=20" in url


def test_search_close_failure_still_releases_profile_lock(tmp_path, monkeypatch) -> None:
    settings = replace(
        get_settings(),
        data_dir=tmp_path,
        db_path=tmp_path / "kernel.sqlite3",
        artifacts_dir=tmp_path / "artifacts",
        profiles_dir=tmp_path / "profiles",
    )
    init_db(settings)
    profile = create_or_get_profile("owner", settings)

    class FakeResponse:
        status = 200

        async def json(self):
            return {"data": {"result": []}}

    class FakeRequest:
        async def get(self, *_args, **_kwargs):
            return FakeResponse()

    class FakeContext:
        request = FakeRequest()

    class CloseFailureManaged:
        context = FakeContext()

        async def close(self) -> None:
            raise RuntimeError("expected close failure")

    class FakeBrowserContextManager:
        def __init__(self, _settings) -> None:
            pass

        async def open_context(self, _profile_id):
            return CloseFailureManaged()

    monkeypatch.setattr(
        "app.bilibili.search.BrowserContextManager",
        FakeBrowserContextManager,
    )

    with pytest.raises(RuntimeError, match="expected close failure"):
        asyncio.run(
            search_videos_with_profile(
                external_owner_id="owner",
                profile_id=profile["profile_id"],
                keyword="music",
                limit=1,
                settings=settings,
            )
        )

    with get_connection(settings) as conn:
        stored = conn.execute(
            "SELECT active_job_id FROM profiles WHERE profile_id=?",
            (profile["profile_id"],),
        ).fetchone()
    assert stored["active_job_id"] is None
