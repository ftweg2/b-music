from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urljoin, urlparse

import httpx

from app.config import Settings
from app.douyin.links import aweme_id_from_url, canonical_video_url, is_douyin_host, normalize_host
from app.security import sanitize_text


logger = logging.getLogger(__name__)

DETAIL_PATH = "/aweme/v1/web/aweme/detail/"
# After the page reports an item as unavailable, wait briefly for a repeated
# request that carries the item before accepting the negative answer.
UNAVAILABLE_GRACE_SECONDS = 2.0
MAX_SHORT_LINK_REDIRECTS = 5
# Lookups beyond this many waiting for a browser are refused instead of queued.
MAX_WAITING_LOOKUPS = 4
# Small-machine launch flags. One renderer and no GPU, sync, extension or
# background services measured ~20% less peak memory and half the processes
# for a lookup, with no loss of speed. Cross-site frames are blocked anyway.
LOOKUP_BROWSER_ARGS = (
    "--disable-dev-shm-usage",
    "--mute-audio",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--no-first-run",
    "--metrics-recording-only",
    "--renderer-process-limit=1",
    "--disable-features=Translate,OptimizationHints,MediaRouter,BackForwardCache",
)
# The detail JSON is all this module needs from the page. Skipping images,
# video, fonts, styles and long-lived connections avoids playback and noise.
BLOCKED_RESOURCE_TYPES = frozenset({
    "image", "media", "font", "stylesheet", "websocket", "eventsource", "manifest", "texttrack",
})
# Analytics and performance beacons. A lookup never needs them, and the kernel
# does not report its own browsing to third parties.
TELEMETRY_HOST_SUFFIXES = ("zijieapi.com", "ibytedapm.com")
# Media URLs come from Douyin's own JSON. Downloads (and their redirects) may
# only reach Douyin's media CDNs, never an arbitrary host named in a response.
MEDIA_HOST_SUFFIXES = (
    "douyinstatic.com",
    "douyinvod.com",
    "douyincdn.com",
    "zjcdn.com",
    "bytecdn.cn",
    "amemv.com",
    "snssdk.com",
)


class DouyinUnavailable(RuntimeError):
    def __init__(self, failure_code: str, reason: str) -> None:
        super().__init__(reason)
        self.failure_code = failure_code
        self.reason = reason


class MediaHostNotAllowed(RuntimeError):
    pass


@dataclass(frozen=True)
class DouyinMusic:
    title: str | None
    author: str | None
    duration_seconds: int | None
    play_urls: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DouyinAweme:
    aweme_id: str
    desc: str
    author: str | None
    duration_seconds: int | None
    music: DouyinMusic | None
    video_play_urls: list[str] = field(default_factory=list)
    # Signed, expiring image URLs from the page's own detail. They are used once
    # to cache the cover inside the kernel and are never returned to clients.
    cover_urls: list[str] = field(default_factory=list)

    @property
    def music_urls(self) -> list[str]:
        return [url for url in (self.music.play_urls if self.music else []) if is_allowed_media_url(url)]

    @property
    def video_urls(self) -> list[str]:
        return [url for url in self.video_play_urls if is_allowed_media_url(url)]


def _host_matches(host: str, suffixes: tuple[str, ...]) -> bool:
    return any(host == suffix or host.endswith("." + suffix) for suffix in suffixes)


def is_allowed_media_url(url: str) -> bool:
    parsed = urlparse(url or "")
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        return False
    return _host_matches(normalize_host(parsed.hostname), MEDIA_HOST_SUFFIXES)


def is_allowed_page_url(url: str) -> bool:
    """Documents (top-level pages and frames) the lookup browser may load."""
    parsed = urlparse(url or "")
    return parsed.scheme == "https" and _host_matches(normalize_host(parsed.hostname), ("douyin.com",))


def lookup_request_allowed(url: str, resource_type: str) -> bool:
    if resource_type in BLOCKED_RESOURCE_TYPES:
        return False
    if _host_matches(normalize_host(urlparse(url or "").hostname), TELEMETRY_HOST_SUFFIXES):
        return False
    if resource_type == "document" and not is_allowed_page_url(url):
        return False
    return True


async def reject_disallowed_media_host(request: httpx.Request) -> None:
    """httpx request hook: also applied to every redirect hop."""
    if not is_allowed_media_url(str(request.url)):
        raise MediaHostNotAllowed(f"media host is not an allowed Douyin CDN: {request.url.host}")


def parse_aweme_detail(payload: object, aweme_id: str) -> DouyinAweme:
    detail = payload.get("aweme_detail") if isinstance(payload, dict) else None
    if not isinstance(detail, dict):
        filter_detail = payload.get("filter_detail") if isinstance(payload, dict) else None
        reason = filter_detail.get("filter_reason") if isinstance(filter_detail, dict) else None
        raise DouyinUnavailable(
            "DOUYIN_ITEM_UNAVAILABLE",
            f"Douyin item is unavailable or private ({reason or 'no detail'})",
        )
    music_data = detail.get("music") if isinstance(detail.get("music"), dict) else {}
    video_data = detail.get("video") if isinstance(detail.get("video"), dict) else {}
    author_data = detail.get("author") if isinstance(detail.get("author"), dict) else {}
    music = None
    if music_data:
        music = DouyinMusic(
            title=_optional_text(music_data.get("title")),
            author=_optional_text(music_data.get("author")),
            duration_seconds=_seconds(music_data.get("duration"), already_seconds=True),
            play_urls=_url_list(music_data.get("play_url")),
        )
    return DouyinAweme(
        aweme_id=str(detail.get("aweme_id") or aweme_id),
        desc=_optional_text(detail.get("desc")) or "",
        author=_optional_text(author_data.get("nickname")),
        duration_seconds=_seconds(video_data.get("duration") or detail.get("duration")),
        music=music,
        video_play_urls=_url_list(video_data.get("play_addr")),
        cover_urls=list(dict.fromkeys(
            _url_list(video_data.get("cover")) + _url_list(video_data.get("origin_cover"))
        )),
    )


async def resolve_short_link(
    url: str,
    settings: Settings,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    """Follow a v.douyin.com share link, one hop at a time, until it names an item id.

    Every hop must stay on a Douyin host; the target is checked before it is requested.
    """
    current = url
    timeout = httpx.Timeout(settings.request_timeout_seconds)
    headers = {"user-agent": settings.bilibili_user_agent}
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, transport=transport, headers=headers) as client:
        for _ in range(MAX_SHORT_LINK_REDIRECTS + 1):
            aweme_id = aweme_id_from_url(current)
            if aweme_id:
                return aweme_id
            parsed = urlparse(current)
            if parsed.scheme not in {"http", "https"} or not is_douyin_host(parsed.hostname):
                raise DouyinUnavailable("DOUYIN_LINK_UNRESOLVED", "share link redirected outside Douyin")
            response = await client.get(current)
            location = response.headers.get("location")
            if response.status_code not in {301, 302, 303, 307, 308} or not location:
                raise DouyinUnavailable(
                    "DOUYIN_LINK_UNRESOLVED",
                    f"share link did not redirect to a video (HTTP {response.status_code})",
                )
            current = urljoin(current, location)
    raise DouyinUnavailable("DOUYIN_LINK_UNRESOLVED", "share link redirected too many times")


async def fetch_aweme_detail(
    aweme_id: str,
    settings: Settings,
    raise_if_cancelled: Callable[[], None] | None = None,
) -> DouyinAweme:
    """Open the public video page in a fresh, cookie-less browser and read the item
    detail that the page itself requests. No login, profile or stored state is used."""
    cached = _cached_detail(aweme_id)
    if cached is not None:
        return cached
    async with _browser_slot(settings.douyin_max_browsers):
        playwright, browser = await _launch_browser(settings)
        try:
            payload = await _capture_detail(browser, aweme_id, settings, raise_if_cancelled)
        finally:
            with contextlib.suppress(Exception):
                await browser.close()
            with contextlib.suppress(Exception):
                await playwright.stop()
    aweme = parse_aweme_detail(payload, aweme_id)
    _remember_detail(aweme_id, aweme)
    return aweme


# An App normally resolves a link for its title and then submits a job for the
# same item seconds later. Keeping the parsed detail briefly (in memory only,
# never persisted) lets the job skip a second page load. Signed media URLs in
# the detail stay valid far longer than this window.
DETAIL_CACHE_SECONDS = 120.0
DETAIL_CACHE_MAX_ITEMS = 64
_DETAIL_CACHE: dict[str, tuple[float, DouyinAweme]] = {}


def _cached_detail(aweme_id: str) -> DouyinAweme | None:
    entry = _DETAIL_CACHE.get(aweme_id)
    if entry is None:
        return None
    stored_at, aweme = entry
    if time.monotonic() - stored_at >= DETAIL_CACHE_SECONDS:
        _DETAIL_CACHE.pop(aweme_id, None)
        return None
    return aweme


def _remember_detail(aweme_id: str, aweme: DouyinAweme) -> None:
    now = time.monotonic()
    for key, (stored_at, _aweme) in list(_DETAIL_CACHE.items()):
        if now - stored_at >= DETAIL_CACHE_SECONDS:
            _DETAIL_CACHE.pop(key, None)
    while len(_DETAIL_CACHE) >= DETAIL_CACHE_MAX_ITEMS:
        _DETAIL_CACHE.pop(next(iter(_DETAIL_CACHE)))
    _DETAIL_CACHE[aweme_id] = (now, aweme)


async def _capture_detail(
    browser: object,
    aweme_id: str,
    settings: Settings,
    raise_if_cancelled: Callable[[], None] | None,
) -> dict[str, object]:
    loop = asyncio.get_running_loop()
    found: asyncio.Future[dict[str, object]] = loop.create_future()
    latest: dict[str, object] = {}

    async def on_response(response: object) -> None:
        if found.done() or not _is_detail_response(str(response.url), aweme_id):
            return
        try:
            payload = await response.json()
        except Exception:
            return
        if not isinstance(payload, dict):
            return
        latest.setdefault("first_seen_at", loop.time())
        latest["payload"] = payload
        if isinstance(payload.get("aweme_detail"), dict) and not found.done():
            found.set_result(payload)

    def on_crash(*_args: object) -> None:
        # An out-of-memory kill must fail the lookup now, not after the timeout.
        if not found.done():
            found.set_exception(DouyinUnavailable(
                "DOUYIN_BROWSER_CRASHED", "the lookup browser crashed or was killed (often out of memory)",
            ))

    context = await browser.new_context(locale="zh-CN")
    browser.on("disconnected", on_crash)
    try:
        await context.route("**/*", _route_blocking_heavy_resources)
        page = await context.new_page()
        page.on("crash", on_crash)
        page.on("response", on_response)
        timeout = settings.douyin_detail_timeout_seconds
        await page.goto(canonical_video_url(aweme_id), wait_until="commit", timeout=int(timeout * 1000))
        deadline = loop.time() + timeout
        while not found.done():
            if raise_if_cancelled:
                raise_if_cancelled()
            remaining = deadline - loop.time()
            first_seen_at = latest.get("first_seen_at")
            if first_seen_at is not None:
                remaining = min(remaining, first_seen_at + UNAVAILABLE_GRACE_SECONDS - loop.time())
            if remaining <= 0:
                break
            await asyncio.wait({found}, timeout=min(0.25, remaining))
    finally:
        # The caller closes the browser next; that disconnect is not a crash of this
        # lookup and must not leave an unretrieved exception on a pending future.
        browser.remove_listener("disconnected", on_crash)
        with contextlib.suppress(Exception):
            await context.close()
    if found.done():
        return found.result()
    if "payload" in latest:
        # The page answered, but without an item (deleted, private or region-limited).
        return latest["payload"]
    raise DouyinUnavailable("DOUYIN_DETAIL_TIMEOUT", "Douyin page did not return item details in time")


def _is_detail_response(url: str, aweme_id: str) -> bool:
    parsed = urlparse(url)
    if DETAIL_PATH not in parsed.path:
        return False
    return parse_qs(parsed.query).get("aweme_id") == [aweme_id]


async def _route_blocking_heavy_resources(route: object) -> None:
    request = route.request
    if lookup_request_allowed(request.url, request.resource_type):
        await route.continue_()
    else:
        await route.abort()


# The lookup browser runs Douyin's page scripts, so it starts inside Chromium's
# sandbox (Playwright disables it by default). Where the sandbox cannot start,
# such as the Docker image running as root, the container is the boundary: the
# kernel falls back once, logs it, and reports it in strategy debug info.
_sandbox_state: dict[str, bool] = {}


def browser_sandbox_active() -> bool | None:
    """None until the first lookup browser has started."""
    return _sandbox_state.get("active")


async def _launch_browser(settings: Settings) -> tuple[object, object]:
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise RuntimeError("Playwright is not installed") from exc
    playwright = await async_playwright().start()
    options: dict[str, object] = {
        "headless": settings.playwright_headless,
        "args": list(LOOKUP_BROWSER_ARGS),
    }
    if settings.playwright_executable_path:
        options["executable_path"] = settings.playwright_executable_path
    elif settings.playwright_browser_channel:
        options["channel"] = settings.playwright_browser_channel
    try:
        if _sandbox_state.get("active") is not False:
            try:
                browser = await playwright.chromium.launch(**options, chromium_sandbox=True)
                _sandbox_state["active"] = True
                return playwright, browser
            except Exception as exc:
                sandbox_error = sanitize_text(exc, 300)
            browser = await playwright.chromium.launch(**options)
            _sandbox_state["active"] = False
            logger.warning("Chromium sandbox is unavailable for Douyin lookups; running without it: %s", sandbox_error)
            return playwright, browser
        return playwright, await playwright.chromium.launch(**options)
    except BaseException:
        with contextlib.suppress(Exception):
            await playwright.stop()
        raise


@dataclass
class _Slots:
    semaphore: asyncio.Semaphore
    waiting: int = 0


_SLOTS: dict[int, _Slots] = {}


@contextlib.asynccontextmanager
async def _browser_slot(max_browsers: int) -> AsyncIterator[None]:
    # One bounded pool per event loop; asyncio primitives must not cross loops.
    key = id(asyncio.get_running_loop())
    slots = _SLOTS.get(key)
    if slots is None:
        slots = _Slots(asyncio.Semaphore(max(1, max_browsers)))
        _SLOTS[key] = slots
    if slots.semaphore.locked() and slots.waiting >= MAX_WAITING_LOOKUPS:
        raise DouyinUnavailable("DOUYIN_BUSY", "too many Douyin lookups are in progress; retry shortly")
    slots.waiting += 1
    try:
        await slots.semaphore.acquire()
    finally:
        slots.waiting -= 1
    try:
        yield
    finally:
        slots.semaphore.release()


def _url_list(value: object) -> list[str]:
    urls = value.get("url_list") if isinstance(value, dict) else None
    if not isinstance(urls, list):
        return []
    return [url for url in urls if isinstance(url, str) and url]


def _optional_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _seconds(value: object, already_seconds: bool = False) -> int | None:
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    return int(round(value if already_seconds else value / 1000))
