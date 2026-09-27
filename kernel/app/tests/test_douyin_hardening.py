import asyncio
from collections.abc import AsyncIterator
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import init_db
from app.douyin import detail
from app.douyin.detail import DouyinUnavailable, is_allowed_page_url, lookup_request_allowed
from app.main import app
from app.profile_manager import create_or_get_profile
from app.strategies.api_dash import DownloadTooLarge, download_audio


MEDIA_URL = "https://lf3-music-east.douyinstatic.com/obj/ies-music-hj/1.mp3"


@pytest.mark.parametrize(
    ("url", "resource_type", "allowed"),
    [
        ("https://www.douyin.com/video/7687946506598968422", "document", True),
        ("https://lf-douyin-pc-web.douyinstatic.com/app.js", "script", True),
        ("https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1", "fetch", True),
        ("https://www.douyin.com/video/1", "image", False),
        ("https://v5-hl-mly-ov.zjcdn.com/video.mp4", "media", False),
        ("wss://frontier.douyin.com/ws", "websocket", False),
        ("https://mcs.zijieapi.com/list", "xhr", False),
        ("https://lf3-short.ibytedapm.com/slardar", "script", False),
        ("https://example.com/landing", "document", False),
        ("http://www.douyin.com/video/1", "document", False),
        ("https://douyin.com.example.com/", "document", False),
    ],
)
def test_lookup_browser_only_loads_what_the_detail_needs(url, resource_type, allowed) -> None:
    assert lookup_request_allowed(url, resource_type) is allowed


def test_allowed_page_urls_are_https_douyin_only() -> None:
    assert is_allowed_page_url("https://sso.douyin.com/login")
    assert not is_allowed_page_url("https://evil.example/?next=douyin.com")


def test_waiting_lookups_are_bounded(monkeypatch) -> None:
    monkeypatch.setattr(detail, "MAX_WAITING_LOOKUPS", 1)
    monkeypatch.setattr(detail, "_SLOTS", {})

    async def run() -> list[str]:
        release = asyncio.Event()
        outcomes: list[str] = []

        async def holder() -> None:
            async with detail._browser_slot(1):
                outcomes.append("running")
                await release.wait()

        async def waiter() -> None:
            async with detail._browser_slot(1):
                outcomes.append("waited")

        first = asyncio.create_task(holder())
        await asyncio.sleep(0)
        second = asyncio.create_task(waiter())
        await asyncio.sleep(0)
        try:
            async with detail._browser_slot(1):
                outcomes.append("third ran")
        except DouyinUnavailable as exc:
            outcomes.append(exc.failure_code)
        release.set()
        await asyncio.gather(first, second)
        return outcomes

    assert asyncio.run(run()) == ["running", "DOUYIN_BUSY", "waited"]


class FakeChromium:
    def __init__(self, sandbox_works: bool) -> None:
        self.sandbox_works = sandbox_works
        self.launches: list[bool] = []

    async def launch(self, **options):
        sandboxed = options.get("chromium_sandbox", False)
        self.launches.append(sandboxed)
        assert "--mute-audio" in options["args"]
        assert "--no-sandbox" not in options["args"]
        if sandboxed and not self.sandbox_works:
            raise RuntimeError("Running as root without --no-sandbox is not supported")
        return SimpleNamespace(sandboxed=sandboxed)


def use_fake_playwright(monkeypatch, chromium: FakeChromium) -> None:
    class Starter:
        async def start(self):
            return SimpleNamespace(chromium=chromium, stop=_noop)

    monkeypatch.setattr("playwright.async_api.async_playwright", lambda: Starter())
    monkeypatch.setattr(detail, "_sandbox_state", {})


async def _noop() -> None:
    return None


def test_lookup_browser_starts_sandboxed_when_possible(monkeypatch) -> None:
    chromium = FakeChromium(sandbox_works=True)
    use_fake_playwright(monkeypatch, chromium)

    async def run():
        return [await detail._launch_browser(get_settings()) for _ in range(2)]

    launched = asyncio.run(run())

    assert [browser.sandboxed for _playwright, browser in launched] == [True, True]
    assert chromium.launches == [True, True]
    assert detail.browser_sandbox_active() is True


def test_lookup_browser_falls_back_once_where_the_sandbox_cannot_start(monkeypatch, caplog) -> None:
    chromium = FakeChromium(sandbox_works=False)
    use_fake_playwright(monkeypatch, chromium)

    async def run():
        return [await detail._launch_browser(get_settings()) for _ in range(2)]

    launched = asyncio.run(run())

    assert [browser.sandboxed for _playwright, browser in launched] == [False, False]
    # The failed sandboxed start is tried once per process, not before every lookup.
    assert chromium.launches == [True, False, False]
    assert detail.browser_sandbox_active() is False
    assert "sandbox is unavailable" in caplog.text


class ByteStream(httpx.AsyncByteStream):
    def __init__(self, *chunks: bytes) -> None:
        self.chunks = chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            yield chunk


def media_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_download_limit_rejects_declared_oversized_media_before_writing(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("range") == "bytes=0-0":
            return httpx.Response(206, headers={"content-range": "bytes 0-0/5000"}, stream=ByteStream(b"x"))
        raise AssertionError("body must not be requested")

    async def run() -> None:
        async with media_client(handler) as client:
            await download_audio(client, MEDIA_URL, {}, tmp_path / "raw.mp3", get_settings(), max_bytes=1000)

    with pytest.raises(DownloadTooLarge):
        asyncio.run(run())
    assert list(tmp_path.iterdir()) == []


def test_download_limit_stops_undeclared_streams_and_removes_partial_files(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("range"):
            return httpx.Response(200, stream=ByteStream())
        return httpx.Response(200, stream=ByteStream(b"a" * 512, b"a" * 512, b"a" * 512))

    async def run() -> None:
        async with media_client(handler) as client:
            await download_audio(client, MEDIA_URL, {}, tmp_path / "raw.mp3", get_settings(), max_bytes=1000)

    with pytest.raises(DownloadTooLarge):
        asyncio.run(run())
    assert list(tmp_path.iterdir()) == []


def test_download_splits_into_parallel_parts_with_explicit_settings(tmp_path) -> None:
    body = bytes(range(256)) * 16  # 4096 bytes
    ranges: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        value = request.headers.get("range", "")
        ranges.append(value)
        start, end = (int(part) for part in value.removeprefix("bytes=").split("-"))
        return httpx.Response(
            206,
            headers={"content-range": f"bytes {start}-{end}/{len(body)}"},
            stream=ByteStream(body[start:end + 1]),
        )

    async def run() -> dict:
        async with media_client(handler) as client:
            return await download_audio(
                client, MEDIA_URL, {}, tmp_path / "raw.mp3", get_settings(),
                concurrency=4, min_parallel_bytes=1024, max_bytes=10_000,
            )

    info = asyncio.run(run())

    assert info == {"mode": "parallel_range", "chunks": 4, "content_length": len(body)}
    assert (tmp_path / "raw.mp3").read_bytes() == body
    assert sorted(ranges[1:]) == ["bytes=0-1023", "bytes=1024-2047", "bytes=2048-3071", "bytes=3072-4095"]


def test_busy_resolve_is_503_with_retry_after(tmp_path, monkeypatch) -> None:
    settings = replace(
        get_settings(),
        data_dir=tmp_path,
        db_path=tmp_path / "kernel.sqlite3",
        artifacts_dir=tmp_path / "artifacts",
        profiles_dir=tmp_path / "profiles",
    )
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    monkeypatch.setattr("app.routers.douyin.get_settings", lambda: settings)

    async def busy(_aweme_id, _settings, _raise_if_cancelled=None):
        raise DouyinUnavailable("DOUYIN_BUSY", "too many Douyin lookups are in progress; retry shortly")

    monkeypatch.setattr("app.routers.douyin.fetch_aweme_detail", busy)

    response = TestClient(app).post(
        "/v1/douyin/resolve",
        json={
            "external_owner_id": "owner",
            "profile_id": profile["profile_id"],
            "url": "https://www.douyin.com/video/7687946506598968422",
        },
    )

    assert response.status_code == 503
    assert response.headers["retry-after"] == "3"
