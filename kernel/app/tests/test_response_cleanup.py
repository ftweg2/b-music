import asyncio
from dataclasses import replace
from types import SimpleNamespace

import pytest

from app.browser.responses import managed_response
from app.config import get_settings
from app.db import init_db
from app import profile_manager
from app.bilibili.search import search_videos_with_profile


class Response:
    def __init__(self, status=200, broken_json=False, broken_dispose=False):
        self.status = status
        self.broken_json = broken_json
        self.broken_dispose = broken_dispose
        self.disposed = 0

    async def json(self):
        if self.broken_json:
            raise ValueError("invalid json")
        return {"code": 0, "data": {"isLogin": True, "mid": 123, "uname": "name", "result": [], "numPages": 0}}

    async def dispose(self):
        self.disposed += 1
        if self.broken_dispose:
            raise RuntimeError("already closed")


@pytest.mark.parametrize("status,broken_json", [(200, False), (403, False), (200, True)])
def test_identity_response_is_released_on_every_exit(status, broken_json):
    async def run():
        response = Response(status, broken_json)
        async def get(*_args, **_kwargs):
            return response
        context = SimpleNamespace(request=SimpleNamespace(get=get))
        if broken_json:
            with pytest.raises(ValueError):
                await profile_manager._verify_bilibili_identity(context, get_settings())
        else:
            identity = await profile_manager._verify_bilibili_identity(context, get_settings())
            assert identity["logged_in"] == (status == 200)
        assert response.disposed == 1
    asyncio.run(run())


@pytest.mark.parametrize("status,broken_json", [(200, False), (503, False), (200, True)])
def test_search_releases_response_before_lease_and_reader_guard(tmp_path, monkeypatch, status, broken_json):
    settings = replace(get_settings(), data_dir=tmp_path, db_path=tmp_path / "kernel.sqlite3",
                       profiles_dir=tmp_path / "profiles", artifacts_dir=tmp_path / "artifacts")
    init_db(settings)
    profile = profile_manager.create_or_get_profile("cleanup", settings)
    response = Response(status, broken_json)
    closed = []
    async def get(*_args, **_kwargs):
        return response
    async def close():
        assert response.disposed == 1
        closed.append(True)
    class Manager:
        def __init__(self, _settings):
            pass
        async def open_request_context(self, _profile):
            return SimpleNamespace(context=SimpleNamespace(request=SimpleNamespace(get=get)), close=close)
    monkeypatch.setattr("app.bilibili.search.BrowserContextManager", Manager)
    async def run():
        call = search_videos_with_profile(external_owner_id="cleanup", profile_id=profile["profile_id"],
                                         keyword="synthetic", limit=20, settings=settings)
        if broken_json or status >= 400:
            with pytest.raises(Exception):
                await call
        else:
            assert (await call)["results"] == []
        assert response.disposed == 1
        assert closed == [True]
        profile_manager.lock_profile(profile["profile_id"], "after-cleanup", settings)
        profile_manager.release_profile_lock(profile["profile_id"], "after-cleanup", settings)
    asyncio.run(run())


def test_failed_disposal_does_not_replace_original_error():
    async def run():
        response = Response(broken_dispose=True)
        with pytest.raises(ValueError, match="original"):
            async with managed_response(response):
                raise ValueError("original")
        assert response.disposed == 1
    asyncio.run(run())
