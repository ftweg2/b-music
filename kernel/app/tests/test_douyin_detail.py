import asyncio
from dataclasses import replace

import httpx
import pytest

from app.config import get_settings
from app.douyin import detail
from app.douyin.detail import (
    DouyinUnavailable,
    MediaHostNotAllowed,
    is_allowed_media_url,
    parse_aweme_detail,
    reject_disallowed_media_host,
    resolve_short_link,
)


AWEME_ID = "7687946506598968422"
MUSIC_URL = "https://lf3-music-east.douyinstatic.com/obj/ies-music-hj/7687932641961691962.mp3"
VIDEO_URL = "https://v5-hl-mly-ov.zjcdn.com/abc/video/tos/cn/video.mp4?a=1"


def detail_payload(**overrides) -> dict:
    item = {
        "aweme_id": AWEME_ID,
        "desc": "  一首歌 #音乐  ",
        "author": {"nickname": "作者"},
        "video": {"duration": 83880, "play_addr": {"url_list": [VIDEO_URL]}},
        "music": {
            "title": "@作者创作的原声",
            "author": "作者",
            "duration": 83,
            "play_url": {"url_list": [MUSIC_URL, "https://evil.example/steal.mp3"]},
        },
    }
    item.update(overrides)
    return {"aweme_detail": item, "status_code": 0}


def test_parse_aweme_detail_extracts_music_and_filters_media_hosts() -> None:
    aweme = parse_aweme_detail(detail_payload(), AWEME_ID)

    assert aweme.aweme_id == AWEME_ID
    assert aweme.desc == "一首歌 #音乐"
    assert aweme.author == "作者"
    assert aweme.duration_seconds == 84
    assert aweme.music.title == "@作者创作的原声"
    assert aweme.music.duration_seconds == 83
    assert aweme.music_urls == [MUSIC_URL]
    assert aweme.video_urls == [VIDEO_URL]


def test_parse_aweme_detail_without_music_keeps_video_fallback() -> None:
    aweme = parse_aweme_detail(detail_payload(music=None), AWEME_ID)

    assert aweme.music is None
    assert aweme.music_urls == []
    assert aweme.video_urls == [VIDEO_URL]


def test_parse_aweme_detail_reports_filtered_items() -> None:
    payload = {"aweme_detail": None, "filter_detail": {"aweme_id": AWEME_ID, "filter_reason": "core_dep"}}

    with pytest.raises(DouyinUnavailable) as caught:
        parse_aweme_detail(payload, AWEME_ID)

    assert caught.value.failure_code == "DOUYIN_ITEM_UNAVAILABLE"
    assert "core_dep" in caught.value.reason


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        (MUSIC_URL, True),
        (VIDEO_URL, True),
        ("https://v26-web.douyinvod.com/x/video.mp4", True),
        ("https://aweme.snssdk.com/aweme/v1/play/?video_id=1", True),
        ("https://douyinstatic.com.evil.example/a.mp3", False),
        ("https://evildouyinstatic.com/a.mp3", False),
        ("https://user@lf3-music-east.douyinstatic.com/a.mp3", False),
        ("file:///etc/passwd", False),
        ("http://127.0.0.1:8000/v1/jobs", False),
    ],
)
def test_media_host_allowlist(url, allowed) -> None:
    assert is_allowed_media_url(url) is allowed


def test_media_redirects_to_other_hosts_are_blocked_before_they_are_requested() -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.host)
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data"})

    async def run() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            follow_redirects=True,
            event_hooks={"request": [reject_disallowed_media_host]},
        ) as client:
            await client.get(MUSIC_URL)

    with pytest.raises(MediaHostNotAllowed):
        asyncio.run(run())
    assert requested == ["lf3-music-east.douyinstatic.com"]


def test_short_link_resolution_stops_at_first_douyin_page_with_an_id() -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(
            302,
            headers={"location": f"https://www.iesdouyin.com/share/video/{AWEME_ID}/?region=CN"},
        )

    aweme_id = asyncio.run(
        resolve_short_link("https://v.douyin.com/iRNBho6x/", get_settings(), httpx.MockTransport(handler))
    )

    assert aweme_id == AWEME_ID
    assert requested == ["https://v.douyin.com/iRNBho6x/"]


def test_short_link_redirect_outside_douyin_is_not_followed() -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.host)
        return httpx.Response(302, headers={"location": "https://example.com/next"})

    with pytest.raises(DouyinUnavailable) as caught:
        asyncio.run(
            resolve_short_link("https://v.douyin.com/iRNBho6x/", get_settings(), httpx.MockTransport(handler))
        )

    assert caught.value.failure_code == "DOUYIN_LINK_UNRESOLVED"
    assert requested == ["v.douyin.com"]


def test_short_link_without_redirect_is_reported() -> None:
    transport = httpx.MockTransport(lambda _request: httpx.Response(200, text="<html></html>"))

    with pytest.raises(DouyinUnavailable, match="HTTP 200"):
        asyncio.run(resolve_short_link("https://v.douyin.com/iRNBho6x/", get_settings(), transport))


class FakeResponse:
    def __init__(self, url: str, payload: object) -> None:
        self.url = url
        self._payload = payload

    async def json(self) -> object:
        return self._payload


class FakePage:
    def __init__(self, responses: list[FakeResponse], crash: bool = False) -> None:
        self._responses = responses
        self._handlers = []
        self._crash_handlers = []
        self._crash = crash
        self.visited: list[str] = []

    def on(self, event: str, handler) -> None:
        assert event in {"response", "crash"}
        (self._handlers if event == "response" else self._crash_handlers).append(handler)

    async def goto(self, url: str, **_kwargs) -> None:
        self.visited.append(url)
        if self._crash:
            for handler in self._crash_handlers:
                handler(self)
            return
        for response in self._responses:
            for handler in self._handlers:
                await handler(response)


class FakeContext:
    def __init__(self, page: FakePage) -> None:
        self.page = page
        self.routed = False
        self.closed = False

    async def route(self, _pattern: str, _handler) -> None:
        self.routed = True

    async def new_page(self) -> FakePage:
        return self.page

    async def close(self) -> None:
        self.closed = True


class FakeBrowser:
    def __init__(self, page: FakePage) -> None:
        self.context = FakeContext(page)
        self.context_options: dict = {}
        self.events: list[str] = []
        self.listeners: list[tuple[str, object]] = []

    def on(self, event: str, handler) -> None:
        self.events.append(event)
        self.listeners.append((event, handler))

    def remove_listener(self, event: str, handler) -> None:
        self.listeners.remove((event, handler))

    def disconnect(self) -> None:
        for event, handler in list(self.listeners):
            if event == "disconnected":
                handler(self)

    async def new_context(self, **options) -> FakeContext:
        self.context_options = options
        return self.context


def detail_url(aweme_id: str) -> str:
    return f"https://www.douyin.com/aweme/v1/web/aweme/detail/?device_platform=webapp&aweme_id={aweme_id}&a_bogus=x"


def fast_settings():
    return replace(get_settings(), douyin_detail_timeout_seconds=1.0)


def test_capture_uses_a_fresh_context_and_ignores_other_items() -> None:
    other = detail_payload(aweme_id="7000000000000000001")
    page = FakePage([
        FakeResponse(detail_url("7000000000000000001"), other),
        FakeResponse("https://www.douyin.com/aweme/v1/web/social/count", {"aweme_detail": {}}),
        FakeResponse(detail_url(AWEME_ID), detail_payload()),
    ])
    browser = FakeBrowser(page)

    payload = asyncio.run(detail._capture_detail(browser, AWEME_ID, fast_settings(), None))

    assert payload["aweme_detail"]["aweme_id"] == AWEME_ID
    assert page.visited == [f"https://www.douyin.com/video/{AWEME_ID}"]
    assert browser.context.routed and browser.context.closed
    assert "storage_state" not in browser.context_options


def test_capture_returns_unavailable_answer_after_short_grace(monkeypatch) -> None:
    monkeypatch.setattr(detail, "UNAVAILABLE_GRACE_SECONDS", 0.05)
    unavailable = {"aweme_detail": None, "filter_detail": {"filter_reason": "core_dep"}}
    page = FakePage([FakeResponse(detail_url(AWEME_ID), unavailable)])

    payload = asyncio.run(detail._capture_detail(FakeBrowser(page), AWEME_ID, fast_settings(), None))

    with pytest.raises(DouyinUnavailable, match="core_dep"):
        parse_aweme_detail(payload, AWEME_ID)


def test_closing_the_browser_after_an_unavailable_answer_is_not_a_crash(monkeypatch) -> None:
    monkeypatch.setattr(detail, "UNAVAILABLE_GRACE_SECONDS", 0.05)
    unavailable = {"aweme_detail": None, "filter_detail": {"filter_reason": "core_dep"}}
    browser = FakeBrowser(FakePage([FakeResponse(detail_url(AWEME_ID), unavailable)]))

    asyncio.run(detail._capture_detail(browser, AWEME_ID, fast_settings(), None))

    assert "disconnected" in browser.events
    assert browser.listeners == []
    browser.disconnect()  # what fetch_aweme_detail's browser.close() triggers


def test_capture_times_out_without_detail() -> None:
    settings = replace(get_settings(), douyin_detail_timeout_seconds=0.2)

    with pytest.raises(DouyinUnavailable) as caught:
        asyncio.run(detail._capture_detail(FakeBrowser(FakePage([])), AWEME_ID, settings, None))

    assert caught.value.failure_code == "DOUYIN_DETAIL_TIMEOUT"


def test_fetch_reuses_a_recent_detail_without_a_second_browser(monkeypatch) -> None:
    monkeypatch.setattr(detail, "_DETAIL_CACHE", {})
    launches: list[str] = []

    class FakePlaywright:
        async def stop(self) -> None:
            pass

    class ClosableBrowser(FakeBrowser):
        async def close(self) -> None:
            pass

    async def fake_launch(_settings):
        launches.append("launch")
        page = FakePage([FakeResponse(detail_url(AWEME_ID), detail_payload())])
        return FakePlaywright(), ClosableBrowser(page)

    monkeypatch.setattr(detail, "_launch_browser", fake_launch)

    async def run():
        first = await detail.fetch_aweme_detail(AWEME_ID, fast_settings())
        second = await detail.fetch_aweme_detail(AWEME_ID, fast_settings())
        return first, second

    first, second = asyncio.run(run())

    assert first == second
    assert launches == ["launch"]

    monkeypatch.setattr(detail, "DETAIL_CACHE_SECONDS", 0.0)
    asyncio.run(detail.fetch_aweme_detail(AWEME_ID, fast_settings()))
    assert launches == ["launch", "launch"]


def test_unavailable_items_are_not_cached(monkeypatch) -> None:
    monkeypatch.setattr(detail, "_DETAIL_CACHE", {})
    monkeypatch.setattr(detail, "UNAVAILABLE_GRACE_SECONDS", 0.01)
    launches: list[str] = []

    class FakePlaywright:
        async def stop(self) -> None:
            pass

    class ClosableBrowser(FakeBrowser):
        async def close(self) -> None:
            pass

    async def fake_launch(_settings):
        launches.append("launch")
        unavailable = {"aweme_detail": None, "filter_detail": {"filter_reason": "core_dep"}}
        return FakePlaywright(), ClosableBrowser(FakePage([FakeResponse(detail_url(AWEME_ID), unavailable)]))

    monkeypatch.setattr(detail, "_launch_browser", fake_launch)

    for _ in range(2):
        with pytest.raises(DouyinUnavailable):
            asyncio.run(detail.fetch_aweme_detail(AWEME_ID, fast_settings()))
    assert launches == ["launch", "launch"]


def test_crashed_lookup_page_fails_immediately_instead_of_timing_out() -> None:
    settings = replace(get_settings(), douyin_detail_timeout_seconds=30.0)
    browser = FakeBrowser(FakePage([], crash=True))

    async def run() -> float:
        started = asyncio.get_running_loop().time()
        with pytest.raises(DouyinUnavailable) as caught:
            await detail._capture_detail(browser, AWEME_ID, settings, None)
        assert caught.value.failure_code == "DOUYIN_BROWSER_CRASHED"
        return asyncio.get_running_loop().time() - started

    assert asyncio.run(run()) < 1.0
    assert "disconnected" in browser.events
    assert browser.context.closed


def test_capture_observes_cancellation() -> None:
    class Cancelled(Exception):
        pass

    def raise_if_cancelled() -> None:
        raise Cancelled()

    browser = FakeBrowser(FakePage([]))
    with pytest.raises(Cancelled):
        asyncio.run(detail._capture_detail(browser, AWEME_ID, fast_settings(), raise_if_cancelled))
    assert browser.context.closed
