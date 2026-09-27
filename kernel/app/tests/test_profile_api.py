import asyncio
from copy import deepcopy
from dataclasses import replace
import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from app.bilibili.profile_api import open_profile_api_client
from app.browser import context_manager as runtime
from app.browser.http_state import CookieStateStore
from app.config import get_settings
from app.db import init_db
from app.profile_manager import create_or_get_profile, profile_storage_dir
from app.strategies.api_dash import ApiDashStrategy
from app.strategies.base import StrategyContext


def cookie(value):
    return {"name": "SESSDATA", "value": "synthetic-" + value, "domain": ".bilibili.com", "path": "/",
            "expires": -1, "httpOnly": True, "secure": True, "sameSite": "Lax"}


@pytest.fixture
def harness(tmp_path, monkeypatch):
    settings = replace(get_settings(), data_dir=tmp_path, db_path=tmp_path / "kernel.sqlite3",
                       profiles_dir=tmp_path / "profiles", artifacts_dir=tmp_path / "artifacts")
    init_db(settings)
    profile = create_or_get_profile("dash-owner", settings)["profile_id"]
    state = SimpleNamespace(calls=[], responses=[], events=[], status=200, broken_json=False,
                            hold_body=False, timeout=False, entered=None, jar=None)

    class Response:
        def __init__(self, payload):
            self.status = state.status
            self.headers = {"content-type": "application/json", "set-cookie": "SESSDATA=synthetic-rotated"}
            self.payload = payload
            self.disposed = 0
        async def body(self):
            if state.hold_body:
                state.entered.set()
                await asyncio.Event().wait()
            return b"invalid json" if state.broken_json else json.dumps(self.payload).encode()
        async def dispose(self):
            self.disposed += 1
            state.events.append("response-disposed")

    class Request:
        def __init__(self, cookies):
            self.jar = deepcopy(cookies)
            state.jar = self.jar
        async def get(self, url, **kwargs):
            parsed = urlsplit(url)
            state.calls.append((parsed, parse_qs(parsed.query), deepcopy(self.jar), kwargs))
            assert "cookie" not in kwargs["headers"]
            if state.timeout:
                raise PlaywrightTimeoutError("SESSDATA=synthetic-secret must not escape")
            if parsed.path.endswith("/view"):
                payload = {"code": 0, "data": {"aid": 123, "title": "Test song", "pages": [{"cid": 456, "page": 1}]}}
            elif parsed.path.endswith("/nav"):
                self.jar[:] = [cookie("rotated")]
                payload = {"code": 0, "data": {"wbi_img": {
                    "img_url": "https://i0.hdslb.com/bfs/wbi/" + "a" * 32 + ".png",
                    "sub_url": "https://i0.hdslb.com/bfs/wbi/" + "b" * 32 + ".png"}}}
            else:
                assert parsed.path.endswith("/playurl")
                assert self.jar == [cookie("rotated")]
                payload = {"code": 0, "data": {"dash": {"audio": [
                    {"id": 30216, "bandwidth": 64000, "baseUrl": "https://media.bilivideo.com/low.m4s?sign=synthetic"},
                    {"id": 30280, "bandwidth": 192000, "baseUrl": "https://media.bilivideo.com/high.m4s?sign=synthetic", "codecs": "mp4a.40.2"}]}}}
            response = Response(payload)
            state.responses.append(response)
            return response
        async def storage_state(self):
            return {"cookies": deepcopy(self.jar), "origins": []}
        async def dispose(self):
            state.events.append("request-disposed")

    class Driver:
        async def stop(self):
            state.events.append("driver-stopped")

    async def launch_http(_settings, cookies):
        return Request(cookies), Driver()
    async def refuse_browser(*_args):
        raise AssertionError("API DASH must not launch a browser for an HTTP-owned profile")
    monkeypatch.setattr(runtime, "_launch_request_context", launch_http)
    monkeypatch.setattr(runtime, "_launch_context", refuse_browser)
    return settings, profile, state


def context(settings, profile):
    return StrategyContext(job_id="profile_dash", external_owner_id="dash-owner", profile_id=profile,
        url="https://www.bilibili.com/video/BV1GJ411x7h7", outputs=["m4a"],
        job_dir=settings.artifacts_dir / "profile_dash", settings=settings, logged_in=True)


def test_dash_uses_one_profile_cookie_jar_and_streams_after_releasing_api(harness, monkeypatch):
    settings, profile, state = harness
    async def download(client, url, headers, output, *_args):
        assert url.startswith("https://media.bilivideo.com/high.m4s")
        assert not client.cookies and "cookie" not in headers
        assert state.events[-2:] == ["request-disposed", "driver-stopped"]
        assert all(response.disposed == 1 for response in state.responses)
        output.write_bytes(b"original-audio")
        return {"mode": "single_stream", "chunks": 1}
    monkeypatch.setattr("app.strategies.api_dash.download_audio", download)
    async def run():
        store = CookieStateStore(profile_storage_dir(profile, settings))
        await store.save("http", [cookie("initial")])
        result = await ApiDashStrategy().run(context(settings, profile))
        assert result.status == "succeeded" and result.selected_media["audio_id"] == 30280
        assert result.raw_artifacts[0].read_bytes() == b"original-audio"
        assert [call[0].path for call in state.calls] == [
            "/x/web-interface/view", "/x/web-interface/nav", "/x/player/wbi/playurl"]
        assert state.calls[0][2] == [cookie("initial")]
        assert state.calls[2][2] == [cookie("rotated")]
        assert state.calls[2][1]["cid"] == ["456"] and state.calls[2][1]["w_rid"]
        assert (await store.load()).cookies == [cookie("rotated")]
        assert all(call[3]["timeout"] == int(settings.request_timeout_seconds * 1000) for call in state.calls)
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


@pytest.mark.parametrize("status", [403, 412, 429])
def test_upstream_rejection_is_preserved_and_releases_profile(harness, status):
    settings, profile, state = harness
    state.status = status
    async def run():
        result = await ApiDashStrategy().run(context(settings, profile))
        assert result.failure_code == "METADATA_FAILED" and result.reason == f"metadata HTTP {status}"
        assert len(state.calls) == 1 and state.responses[0].disposed == 1
        assert state.events[-2:] == ["request-disposed", "driver-stopped"]
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


def test_cancelled_api_body_releases_response_and_profile(harness):
    settings, profile, state = harness
    async def run():
        state.hold_body = True
        state.entered = asyncio.Event()
        task = asyncio.create_task(ApiDashStrategy().run(context(settings, profile)))
        await asyncio.wait_for(state.entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert state.responses[0].disposed == 1
        assert state.events[-2:] == ["request-disposed", "driver-stopped"]
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


def test_transport_timeout_does_not_leak_native_session_errors(harness):
    settings, profile, state = harness
    state.timeout = True
    async def run():
        result = await ApiDashStrategy().run(context(settings, profile))
        assert result.status == "failed" and "timed out" in result.reason
        assert "synthetic-secret" not in result.reason
        assert state.events[-2:] == ["request-disposed", "driver-stopped"]
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


def test_invalid_json_still_releases_response_and_profile(harness):
    settings, profile, state = harness
    state.broken_json = True
    async def run():
        with pytest.raises(ValueError):
            await ApiDashStrategy().run(context(settings, profile))
        assert state.responses[0].disposed == 1
        assert state.events[-2:] == ["request-disposed", "driver-stopped"]
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


def test_profile_api_transport_cannot_buffer_media_or_mutate_upstream(harness):
    settings, profile, state = harness
    async def run():
        async with open_profile_api_client(profile, settings) as client:
            with pytest.raises(httpx.UnsupportedProtocol):
                await client.get("https://media.bilivideo.com/audio.m4s")
            with pytest.raises(httpx.UnsupportedProtocol):
                await client.post("https://api.bilibili.com/x/web-interface/view")
        assert not state.calls
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())
