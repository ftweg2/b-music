from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from app.config import Settings, get_settings
from app.profile_manager import profile_storage_dir
from app.browser.http_state import CookieStateStore
from app.browser.responses import dispose_response


@dataclass
class ManagedBrowserContext:
    context: object
    playwright: object
    release: Callable[[], Awaitable[None]] | None = None
    _close_task: asyncio.Task | None = field(default=None, init=False, repr=False)
    _pages: list[object] = field(default_factory=list, init=False, repr=False)

    async def new_page(self):
        if self._close_task is not None:
            raise RuntimeError("browser lease has already been released")
        page = await self.context.new_page()
        self._pages.append(page)
        return page

    async def _release_owned_resources(self) -> None:
        try:
            for page in self._pages:
                with contextlib.suppress(Exception):
                    await page.close()
            self._pages.clear()
        finally:
            if self.release:
                await self.release()
            else:
                await _close_owned(self.context, self.playwright)

    async def close(self) -> None:
        # A lease is released once, including when callers retry cleanup or are cancelled.
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._release_owned_resources())
        try:
            await asyncio.shield(self._close_task)
        except asyncio.CancelledError:
            # Repeated cancellation must not release the profile guard while a
            # browser, request driver or journal writer is still closing.
            while not self._close_task.done():
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await asyncio.shield(self._close_task)
            with contextlib.suppress(BaseException):
                self._close_task.result()
            raise


async def _close_owned(context: object, playwright: object) -> None:
    try:
        await context.close()
    finally:
        with contextlib.suppress(Exception):
            await playwright.stop()


@dataclass
class _BrowserState:
    profile_id: str
    settings: Settings
    store: CookieStateStore = field(repr=False)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    context: object | None = None
    playwright: object | None = None
    users: int = 0
    mse_hook_installed: bool = False
    shutting_down: bool = False
    request_context: object | None = field(default=None, repr=False)
    request_playwright: object | None = None
    request_view: object | None = field(default=None, repr=False)
    request_users: int = 0
    browser_waiters: int = 0
    condition: asyncio.Condition = field(init=False, repr=False)

    def __post_init__(self):
        self.condition = asyncio.Condition(self.lock)


# One active cookie jar per profile and event loop: HTTP-only OR browser-backed.
# Locks outlive leases to serialize a last-close racing a new-open for the same directory.
_STATES: dict[tuple[int, str], _BrowserState] = {}


def _state_for(profile_id: str, settings: Settings) -> _BrowserState:
    directory = profile_storage_dir(profile_id, settings).resolve()
    key = (id(asyncio.get_running_loop()), str(directory))
    state = _STATES.get(key)
    if state is None:
        state = _BrowserState(profile_id=profile_id, settings=settings, store=CookieStateStore(directory))
        _STATES[key] = state
    return state


async def _launch_context(profile_id: str, settings: Settings) -> tuple[object, object]:
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise RuntimeError("Playwright is not installed") from exc
    user_data_dir = profile_storage_dir(profile_id, settings)
    user_data_dir.mkdir(parents=True, exist_ok=True)
    playwright = await async_playwright().start()
    options: dict[str, object] = {
        "user_data_dir": str(user_data_dir),
        "headless": settings.playwright_headless,
        "user_agent": settings.bilibili_user_agent,
        "args": ["--disable-dev-shm-usage"],
    }
    if settings.playwright_executable_path:
        options["executable_path"] = settings.playwright_executable_path
    elif settings.playwright_browser_channel:
        options["channel"] = settings.playwright_browser_channel
    context = None
    try:
        context = await playwright.chromium.launch_persistent_context(**options)
        return context, playwright
    except BaseException:
        if context is not None:
            with contextlib.suppress(Exception):
                await context.close()
        with contextlib.suppress(Exception):
            await playwright.stop()
        raise


async def _launch_request_context(settings: Settings, cookies: list[dict]) -> tuple[object, object]:
    from playwright.async_api import async_playwright
    playwright = await async_playwright().start()
    request = None
    try:
        request = await playwright.request.new_context(
            user_agent=settings.bilibili_user_agent,
            storage_state={"cookies": cookies, "origins": []},
            timeout=int(settings.request_timeout_seconds * 1000),
        )
        return request, playwright
    except BaseException as exc:
        if request is not None:
            with contextlib.suppress(Exception):
                await request.dispose()
        with contextlib.suppress(Exception):
            await playwright.stop()
        if not isinstance(exc, Exception):
            raise
        # Browser/API validation errors can quote supplied storage-state values.
        raise RuntimeError("Unable to initialize kernel HTTP session") from None


async def _start_browser(state: _BrowserState) -> None:
    snapshot = await state.store.load()
    context, playwright = await _launch_context(state.profile_id, state.settings)
    try:
        if hasattr(context, "cookies"):
            if snapshot is not None and snapshot.source == "http":
                # This transfer happens with no HTTP leases/in-flight requests.
                # Clear deletions too; add_cookies alone could resurrect logout/expiry.
                await context.clear_cookies()
                await context.add_cookies(snapshot.cookies)
            await state.store.save("browser", await context.cookies())
    except BaseException as exc:
        await _close_owned(context, playwright)
        if not isinstance(exc, Exception):
            raise
        raise RuntimeError("Unable to restore kernel browser session") from None
    state.context, state.playwright = context, playwright
    state.mse_hook_installed = False


async def _close_browser(state: _BrowserState) -> None:
    cookies = None
    try:
        try:
            if hasattr(state.context, "cookies"):
                cookies = await state.context.cookies()
        finally:
            await _close_owned(state.context, state.playwright)
        if cookies is not None:
            # A crash/write failure before this point leaves source=browser,
            # so the next request recovers the actual persistent Chrome profile.
            await state.store.save("http", cookies)
    finally:
        state.context = state.playwright = None
        state.users = 0
        state.mse_hook_installed = False
        state.store.forget()


async def _persist_request_locked(state: _BrowserState) -> None:
    snapshot = await state.request_context.storage_state()
    await state.store.save("http", snapshot["cookies"])


async def _close_request(state: _BrowserState) -> None:
    try:
        try:
            await _persist_request_locked(state)
        finally:
            try:
                await state.request_context.dispose()
            finally:
                with contextlib.suppress(Exception):
                    await state.request_playwright.stop()
    finally:
        state.request_context = state.request_playwright = state.request_view = None
        state.request_users = 0
        state.store.forget()


class _RequestProxy:
    def __init__(self, state: _BrowserState):
        self._state = state
        self._request = state.request_context

    async def get(self, url: str, **kwargs):
        state = self._state
        async with state.condition:
            if state.shutting_down or state.request_context is not self._request:
                raise RuntimeError("HTTP profile lease has been released")
        response = await self._request.get(url, **kwargs)
        try:
            async with state.condition:
                if state.request_context is not self._request:
                    raise RuntimeError("HTTP profile lease has been released")
                # Persist Set-Cookie before reporting QR confirmation/identity.
                # Calls without cookie changes do not rewrite the journal.
                await _persist_request_locked(state)
        except BaseException:
            await dispose_response(response)
            raise
        return response


class _RequestView:
    def __init__(self, state: _BrowserState):
        self.request = _RequestProxy(state)


def _browser_lease(state: _BrowserState) -> ManagedBrowserContext:
    state.users += 1
    context, playwright = state.context, state.playwright

    async def release():
        async with state.condition:
            if state.context is not context:
                return
            state.users -= 1
            if state.users == 0:
                try:
                    await _close_browser(state)
                finally:
                    state.condition.notify_all()
    return ManagedBrowserContext(context=context, playwright=playwright, release=release)


class BrowserContextManager:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    async def open_context(self, profile_id: str, *, add_mse_hook: bool = False) -> ManagedBrowserContext:
        state = _state_for(profile_id, self.settings)
        async with state.condition:
            if state.shutting_down:
                raise RuntimeError("browser runtime is shutting down")
            state.browser_waiters += 1
            try:
                # Existing HTTP readers finish in parallel; new readers wait for
                # this transition, then share the browser's own cookie jar.
                while state.request_users > 0 and not state.shutting_down:
                    await state.condition.wait()
                if state.shutting_down:
                    raise RuntimeError("browser runtime is shutting down")
                if state.context is None:
                    await _start_browser(state)
                if add_mse_hook and not state.mse_hook_installed:
                    await state.context.add_init_script(path=str(Path(__file__).with_name("mse_hook.js")))
                    state.mse_hook_installed = True
            except BaseException:
                if state.context is not None and state.users == 0:
                    await _close_browser(state)
                raise
            finally:
                state.browser_waiters -= 1
                state.condition.notify_all()
            return _browser_lease(state)

    async def open_request_context(self, profile_id: str) -> ManagedBrowserContext:
        state = _state_for(profile_id, self.settings)
        async with state.condition:
            while state.browser_waiters and state.context is None and not state.shutting_down:
                await state.condition.wait()
            if state.shutting_down:
                raise RuntimeError("browser runtime is shutting down")
            if state.context is not None:
                return _browser_lease(state)
            if state.request_context is None:
                snapshot = await state.store.load()
                if ((snapshot is not None and snapshot.source == "browser")
                        or (snapshot is None and await state.store.has_browser_files())):
                    # Migrate a legacy profile once, or recover an interrupted
                    # browser owner. Do not read Chromium's cookie DB directly.
                    await _start_browser(state)
                    await _close_browser(state)
                    snapshot = await state.store.load()
                cookies = snapshot.cookies if snapshot is not None else []
                state.request_context, state.request_playwright = await _launch_request_context(self.settings, cookies)
                state.request_view = _RequestView(state)
            state.request_users += 1
            request, driver, view = state.request_context, state.request_playwright, state.request_view

        async def release():
            async with state.condition:
                if state.request_context is not request:
                    return
                state.request_users -= 1
                if state.request_users == 0:
                    try:
                        await _close_request(state)
                    finally:
                        state.condition.notify_all()
        return ManagedBrowserContext(context=view, playwright=driver, release=release)


async def shutdown_browser_contexts() -> None:
    loop_id = id(asyncio.get_running_loop())
    entries = [(key, state) for key, state in _STATES.items() if key[0] == loop_id]
    for key, state in entries:
        async with state.condition:
            state.shutting_down = True
            if state.context is not None:
                with contextlib.suppress(Exception):
                    await _close_browser(state)
            if state.request_context is not None:
                with contextlib.suppress(Exception):
                    await _close_request(state)
            state.condition.notify_all()
        _STATES.pop(key, None)
