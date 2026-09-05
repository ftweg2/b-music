from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from app.config import Settings, get_settings
from app.profile_manager import profile_storage_dir


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
            # Do not release the database reader/job guard while Chromium is still closing.
            await asyncio.shield(self._close_task)
            raise


async def _close_owned(context: object, playwright: object) -> None:
    try:
        await context.close()
    finally:
        with contextlib.suppress(Exception):
            await playwright.stop()


@dataclass
class _BrowserState:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    context: object | None = None
    playwright: object | None = None
    users: int = 0
    mse_hook_installed: bool = False
    shutting_down: bool = False


# One browser per profile and event loop, never another account or copied cookie store.
# Locks outlive leases to serialize a last-close racing a new-open for the same directory.
_STATES: dict[tuple[int, str], _BrowserState] = {}


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


class BrowserContextManager:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    async def open_context(self, profile_id: str, *, add_mse_hook: bool = False) -> ManagedBrowserContext:
        directory = profile_storage_dir(profile_id, self.settings).resolve()
        key = (id(asyncio.get_running_loop()), str(directory))
        state = _STATES.setdefault(key, _BrowserState())
        async with state.lock:
            if state.shutting_down:
                raise RuntimeError("browser runtime is shutting down")
            if state.context is None:
                state.context, state.playwright = await _launch_context(profile_id, self.settings)
                state.mse_hook_installed = False
            try:
                if add_mse_hook and not state.mse_hook_installed:
                    await state.context.add_init_script(path=str(Path(__file__).with_name("mse_hook.js")))
                    state.mse_hook_installed = True
            except BaseException:
                if state.users == 0:
                    try:
                        await _close_owned(state.context, state.playwright)
                    finally:
                        state.context = state.playwright = None
                raise
            state.users += 1
            context, playwright = state.context, state.playwright

        async def release() -> None:
            async with state.lock:
                if state.context is not context:
                    return
                state.users -= 1
                if state.users > 0:
                    return
                try:
                    await _close_owned(context, playwright)
                finally:
                    state.context = state.playwright = None
                    state.mse_hook_installed = False

        return ManagedBrowserContext(context=context, playwright=playwright, release=release)


async def shutdown_browser_contexts() -> None:
    loop_id = id(asyncio.get_running_loop())
    entries = [(key, state) for key, state in _STATES.items() if key[0] == loop_id]
    for key, state in entries:
        async with state.lock:
            state.shutting_down = True
            if state.context is not None:
                with contextlib.suppress(Exception):
                    await _close_owned(state.context, state.playwright)
                state.context = state.playwright = None
                state.users = 0
        _STATES.pop(key, None)
