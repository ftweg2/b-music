import asyncio
from copy import deepcopy
from dataclasses import replace
import json
import os
from types import SimpleNamespace

import pytest

from app.browser import context_manager as runtime
from app.browser.http_state import CookieStateStore
from app.config import get_settings
from app.db import init_db
from app.profile_manager import (
    ProfileLockedError, acquire_profile_reader, create_or_get_profile, logout_profile,
    profile_storage_dir, release_profile_reader,
)


def cookie(value):
    return {"name": "SESSDATA", "value": "synthetic-" + value, "domain": ".bilibili.com", "path": "/",
            "expires": -1, "httpOnly": True, "secure": True, "sameSite": "Lax"}


class Response:
    def __init__(self):
        self.disposed = False
    async def dispose(self):
        self.disposed = True


class Request:
    def __init__(self, cookies):
        self.jar = deepcopy(cookies)
        self.disposed = False
        self.responses = []
        self.entered = None
        self.finish = None
    async def get(self, url, **_kwargs):
        if self.entered is not None:
            self.entered.set()
            await self.finish.wait()
        if url.startswith("set:"):
            self.jar[:] = [cookie(url[4:])]
        elif url == "delete":
            self.jar.clear()
        response = Response()
        self.responses.append(response)
        return response
    async def storage_state(self):
        return {"cookies": deepcopy(self.jar), "origins": []}
    async def dispose(self):
        self.disposed = True


class Driver:
    def __init__(self):
        self.stopped = False
    async def stop(self):
        self.stopped = True


@pytest.fixture
def harness(tmp_path, monkeypatch):
    settings = replace(get_settings(), data_dir=tmp_path, db_path=tmp_path / "kernel.sqlite3",
                       profiles_dir=tmp_path / "profiles", artifacts_dir=tmp_path / "artifacts")
    init_db(settings)
    profile_id = create_or_get_profile("owner", settings)["profile_id"]
    requests, browsers, drivers, disk = [], [], [], {}

    async def request_launch(_settings, cookies):
        assert all(browser.closed for browser in browsers), "two independent cookie jars are active"
        request, driver = Request(cookies), Driver()
        requests.append(request)
        drivers.append(driver)
        return request, driver

    async def browser_launch(profile, settings):
        assert all(request.disposed for request in requests), "browser started before HTTP requests drained"
        directory = profile_storage_dir(profile, settings)
        original = disk.get(profile, []) if (directory / "Default").exists() else []
        (directory / "Default").mkdir(parents=True, exist_ok=True)
        class Browser:
            def __init__(self):
                self.request = Request(original)
                self.closed = False
            async def cookies(self):
                return deepcopy(self.request.jar)
            async def clear_cookies(self):
                self.request.jar.clear()
            async def add_cookies(self, cookies):
                self.request.jar[:] = deepcopy(cookies)
            async def close(self):
                disk[profile] = deepcopy(self.request.jar)
                self.closed = True
                await self.request.dispose()
            async def add_init_script(self, **_kwargs):
                pass
        browser, driver = Browser(), Driver()
        browsers.append(browser)
        drivers.append(driver)
        return browser, driver

    monkeypatch.setattr(runtime, "_launch_request_context", request_launch)
    monkeypatch.setattr(runtime, "_launch_context", browser_launch)
    return settings, profile_id, requests, browsers, drivers, disk


def test_fresh_http_profile_never_launches_chrome_and_commits_cookies_before_return(harness):
    settings, profile, requests, browsers, drivers, _disk = harness
    async def run():
        manager = runtime.BrowserContextManager(settings)
        first, second = await asyncio.gather(manager.open_request_context(profile), manager.open_request_context(profile))
        assert first.context is second.context
        assert len(requests) == 1 and browsers == []
        response = await first.context.request.get("set:first")
        snapshot = await CookieStateStore(profile_storage_dir(profile, settings)).load()
        assert snapshot.source == "http" and snapshot.cookies == [cookie("first")]
        assert "synthetic-first" not in repr(snapshot)
        await response.dispose()
        await first.close()
        assert not requests[0].disposed
        await second.close()
        assert requests[0].disposed and drivers[0].stopped
        third = await manager.open_request_context(profile)
        assert requests[-1].jar == [cookie("first")]
        await third.context.request.get("delete")
        await third.close()
        assert (await CookieStateStore(profile_storage_dir(profile, settings)).load()).cookies == []
        assert browsers == []
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


def test_browser_handoff_drains_http_and_new_readers_share_the_browser_jar(harness):
    settings, profile, requests, browsers, _drivers, _disk = harness
    async def run():
        manager = runtime.BrowserContextManager(settings)
        http = await manager.open_request_context(profile)
        await http.context.request.get("set:http")
        opening = asyncio.create_task(manager.open_context(profile, add_mse_hook=True))
        await asyncio.sleep(0)
        reading = asyncio.create_task(manager.open_request_context(profile))
        await asyncio.sleep(0)
        assert not opening.done() and not reading.done() and not browsers
        await http.close()
        browser, reader = await asyncio.gather(opening, reading)
        assert len(browsers) == 1 and browser.context is reader.context
        assert await browser.context.cookies() == [cookie("http")]
        assert (await CookieStateStore(profile_storage_dir(profile, settings)).load()).source == "browser"
        await reader.context.request.get("set:browser")
        await browser.close()
        assert not browsers[0].closed
        await reader.close()
        final = await manager.open_request_context(profile)
        assert requests[-1].jar == [cookie("browser")]
        assert len(browsers) == 1
        await final.close()
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


@pytest.mark.parametrize("interrupted", [False, True])
def test_legacy_and_interrupted_browser_profiles_bootstrap_once_without_losing_storage(harness, interrupted):
    settings, profile, requests, browsers, _drivers, disk = harness
    directory = profile_storage_dir(profile, settings)
    (directory / "Default").mkdir()
    local_storage = directory / "Default" / "local-storage-test"
    local_storage.write_text("synthetic localStorage remains inside browser profile")
    disk[profile] = [cookie("current-browser")]
    async def run():
        store = CookieStateStore(directory)
        if interrupted:
            await store.save("browser", [cookie("stale-http")])
        manager = runtime.BrowserContextManager(settings)
        for _ in range(2):
            lease = await manager.open_request_context(profile)
            assert requests[-1].jar == [cookie("current-browser")]
            await lease.close()
        assert len(browsers) == 1
        assert local_storage.read_text() == "synthetic localStorage remains inside browser profile"
        assert "origins" not in json.loads(store.path.read_text())
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


def test_cancelled_browser_waiter_does_not_strand_http_readers(harness):
    settings, profile, requests, browsers, _drivers, _disk = harness
    async def run():
        manager = runtime.BrowserContextManager(settings)
        first = await manager.open_request_context(profile)
        opening = asyncio.create_task(manager.open_context(profile))
        await asyncio.sleep(0)
        reading = asyncio.create_task(manager.open_request_context(profile))
        await asyncio.sleep(0)
        opening.cancel()
        with pytest.raises(asyncio.CancelledError):
            await opening
        second = await asyncio.wait_for(reading, 1)
        assert first.context is second.context and browsers == [] and len(requests) == 1
        await first.close()
        await second.close()
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


def test_parallel_http_gets_do_not_serialize_network_waits(harness):
    settings, profile, requests, _browsers, _drivers, _disk = harness
    async def run():
        manager = runtime.BrowserContextManager(settings)
        leases = await asyncio.gather(*(manager.open_request_context(profile) for _ in range(4)))
        request = requests[0]
        entered, release = [], asyncio.Event()
        original = request.get
        async def delayed(url, **kwargs):
            entered.append(url)
            await release.wait()
            return await original(url, **kwargs)
        request.get = delayed
        tasks = [asyncio.create_task(lease.context.request.get("set:" + str(index))) for index, lease in enumerate(leases)]
        for _ in range(10):
            await asyncio.sleep(0)
        assert len(entered) == 4
        release.set()
        await asyncio.gather(*tasks)
        await asyncio.gather(*(lease.close() for lease in leases))
        assert (await CookieStateStore(profile_storage_dir(profile, settings)).load()).cookies == request.jar
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


def test_logout_cannot_race_http_reader_and_never_resurrects_cached_cookies(harness):
    settings, profile, requests, _browsers, _drivers, _disk = harness
    async def run():
        reader = acquire_profile_reader(profile, "owner", settings)
        manager = runtime.BrowserContextManager(settings)
        lease = await manager.open_request_context(profile)
        await lease.context.request.get("set:before-logout")
        with pytest.raises(ProfileLockedError):
            await logout_profile(profile, "owner", settings)
        await lease.close()
        release_profile_reader(profile, reader, settings)
        await logout_profile(profile, "owner", settings)
        assert not (profile_storage_dir(profile, settings) / "http-session.json").exists()
        next_lease = await manager.open_request_context(profile)
        assert requests[-1].jar == []
        await next_lease.close()
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


def test_expired_proxy_cannot_modify_a_new_profile_session(harness):
    settings, profile, requests, _browsers, _drivers, _disk = harness
    async def run():
        manager = runtime.BrowserContextManager(settings)
        first = await manager.open_request_context(profile)
        await first.close()
        second = await manager.open_request_context(profile)
        with pytest.raises(RuntimeError, match="released"):
            await first.context.request.get("set:stale")
        assert requests[-1].jar == []
        await second.close()
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


def test_failed_journal_write_releases_response_driver_and_lease(harness, monkeypatch):
    settings, profile, requests, _browsers, drivers, _disk = harness
    async def run():
        manager = runtime.BrowserContextManager(settings)
        lease = await manager.open_request_context(profile)
        state = runtime._state_for(profile, settings)
        async def fail(*_args):
            raise OSError("synthetic write failure")
        monkeypatch.setattr(state.store, "save", fail)
        with pytest.raises(OSError):
            await lease.context.request.get("set:uncommitted")
        assert requests[-1].responses[-1].disposed
        with pytest.raises(OSError):
            await lease.close()
        assert requests[-1].disposed and drivers[-1].stopped
        assert state.request_users == 0 and state.request_context is None
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())


def test_shutdown_disposes_http_runtime_and_invalidates_existing_leases(harness):
    settings, profile, requests, _browsers, drivers, _disk = harness
    async def run():
        manager = runtime.BrowserContextManager(settings)
        lease = await manager.open_request_context(profile)
        await runtime.shutdown_browser_contexts()
        assert requests[-1].disposed and drivers[-1].stopped
        with pytest.raises(RuntimeError, match="released"):
            await lease.context.request.get("set:late")
        await lease.close()
    asyncio.run(run())


def test_cookie_journal_is_atomic_owner_only_and_unchanged_reads_do_not_rewrite(tmp_path):
    async def run():
        store = CookieStateStore(tmp_path)
        await store.save("http", [cookie("safe")])
        before = store.path.stat().st_mtime_ns
        await store.save("http", [cookie("safe")])
        assert store.path.stat().st_mtime_ns == before
        assert not list(tmp_path.glob(".http-session-*"))
        if os.name == "posix":
            assert store.path.stat().st_mode & 0o077 == 0
        store.path.write_text('{"cookies":"synthetic-secret-do-not-print"}')
        with pytest.raises(RuntimeError, match="invalid") as error:
            await store.load()
        assert "synthetic-secret" not in str(error.value)
    asyncio.run(run())


@pytest.mark.parametrize("cancelled", [False, True])
def test_http_initialization_redacts_state_values_and_preserves_cancellation(monkeypatch, cancelled):
    stopped = []
    async def create(**_kwargs):
        if cancelled:
            raise asyncio.CancelledError
        raise ValueError("invalid cookie value: synthetic-secret-do-not-print")
    async def stop():
        stopped.append(True)
    async def start():
        return SimpleNamespace(request=SimpleNamespace(new_context=create), stop=stop)
    monkeypatch.setattr("playwright.async_api.async_playwright", lambda: SimpleNamespace(start=start))
    async def run():
        with pytest.raises(asyncio.CancelledError if cancelled else RuntimeError) as error:
            await runtime._launch_request_context(get_settings(), [cookie("private")])
        assert "synthetic-secret" not in str(error.value)
        assert stopped == [True]
    asyncio.run(run())


def test_browser_handoff_redacts_cookie_validation_errors_and_closes_failed_runtime(harness, monkeypatch):
    settings, profile, requests, browsers, drivers, _disk = harness
    original = runtime._launch_context
    async def invalid(*args):
        context, driver = await original(*args)
        async def fail(_cookies):
            raise ValueError("invalid cookie value: synthetic-secret-do-not-print")
        context.add_cookies = fail
        return context, driver
    monkeypatch.setattr(runtime, "_launch_context", invalid)
    async def run():
        manager = runtime.BrowserContextManager(settings)
        request = await manager.open_request_context(profile)
        await request.context.request.get("set:keep")
        await request.close()
        with pytest.raises(RuntimeError) as error:
            await manager.open_context(profile)
        assert "synthetic-secret" not in str(error.value)
        assert browsers[-1].closed and drivers[-1].stopped
        retry = await manager.open_request_context(profile)
        assert requests[-1].jar == [cookie("keep")]
        await retry.close()
        await runtime.shutdown_browser_contexts()
    asyncio.run(run())
