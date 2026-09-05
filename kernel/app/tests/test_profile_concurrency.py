import asyncio
from dataclasses import replace

import pytest

from app.config import get_settings
from app.db import init_db, get_connection
from app.profile_manager import (
    create_or_get_profile, acquire_profile_reader, release_profile_reader,
    lock_profile, release_profile_lock, ProfileLockedError, ProfileOwnershipError,
)
from app.job_manager import create_job, recover_interrupted_runtime
from app.schemas import JobCreateRequest
from app.bilibili.search import search_videos_with_profile
from app.browser.context_manager import BrowserContextManager, shutdown_browser_contexts


def setup(tmp_path):
    settings = replace(get_settings(), data_dir=tmp_path, db_path=tmp_path / "kernel.sqlite3",
                       artifacts_dir=tmp_path / "artifacts", profiles_dir=tmp_path / "profiles")
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    return settings, profile["profile_id"]


def create_audio_job(settings, profile, name="audio_job"):
    return create_job(JobCreateRequest(job_id=name, external_owner_id="owner", profile_id=profile,
                                      url="BV1GJ411x7h7", outputs=["raw"]), settings)


def test_audio_job_and_profile_readers_can_coexist_but_account_mutations_cannot(tmp_path):
    settings, profile = setup(tmp_path)
    create_audio_job(settings, profile)
    lease = acquire_profile_reader(profile, "owner", settings)
    with get_connection(settings) as conn:
        assert conn.execute("SELECT active_job_id FROM profiles WHERE profile_id=?", (profile,)).fetchone()[0] == "audio_job"
    release_profile_lock(profile, "audio_job", settings)
    with pytest.raises(ProfileLockedError):
        lock_profile(profile, "logout_attempt", settings)
    release_profile_reader(profile, lease, settings)
    lock_profile(profile, "logout_attempt", settings)
    release_profile_lock(profile, "logout_attempt", settings)


def test_audio_job_may_start_while_search_is_already_reading(tmp_path):
    settings, profile = setup(tmp_path)
    lease = acquire_profile_reader(profile, "owner", settings)
    assert create_audio_job(settings, profile)["status"] == "queued"
    release_profile_reader(profile, lease, settings)


def test_profile_reads_respect_owner_mutation_locks_and_concurrency_bound(tmp_path):
    settings, profile = setup(tmp_path)
    with pytest.raises(ProfileOwnershipError):
        acquire_profile_reader(profile, "other", settings)
    lock_profile(profile, "login_operation", settings)
    with pytest.raises(ProfileLockedError):
        acquire_profile_reader(profile, "owner", settings)
    release_profile_lock(profile, "login_operation", settings)
    leases = [acquire_profile_reader(profile, "owner", settings) for _ in range(4)]
    with pytest.raises(ProfileLockedError):
        acquire_profile_reader(profile, "owner", settings)
    for lease in leases:
        release_profile_reader(profile, lease, settings)
        release_profile_reader(profile, lease, settings)
    final = acquire_profile_reader(profile, "owner", settings)
    assert final
    release_profile_reader(profile, final, settings)


def test_startup_recovery_clears_abandoned_reader_leases(tmp_path):
    settings, profile = setup(tmp_path)
    acquire_profile_reader(profile, "owner", settings)
    recover_interrupted_runtime(settings)
    with get_connection(settings) as conn:
        assert conn.execute("SELECT COUNT(*) FROM profile_readers").fetchone()[0] == 0


def test_first_unvisited_search_page_succeeds_during_media_processing(tmp_path, monkeypatch):
    settings, profile = setup(tmp_path)
    create_audio_job(settings, profile)
    with get_connection(settings) as conn:
        conn.execute("UPDATE jobs SET status='processing_media',stage='processing_media' WHERE job_id='audio_job'")
    class Response:
        status = 200
        async def json(self): return {"code": 0, "data": {"numPages": 5, "result": [{"bvid": "BV1GJ411x7h7", "title": "song"}]}}
    class Request:
        async def get(self, *_args, **_kwargs): return Response()
    class Context:
        request = Request()
    class Managed:
        context = Context()
        async def close(self): pass
    class Manager:
        def __init__(self, _settings): pass
        async def open_context(self, _profile): return Managed()
    monkeypatch.setattr("app.bilibili.search.BrowserContextManager", Manager)
    result = asyncio.run(search_videos_with_profile(external_owner_id="owner", profile_id=profile,
                                                   keyword="song", limit=20, page=3, settings=settings))
    assert result["results"][0]["bvid"] == "BV1GJ411x7h7"
    with get_connection(settings) as conn:
        assert conn.execute("SELECT status FROM jobs WHERE job_id='audio_job'").fetchone()[0] == "processing_media"
        assert conn.execute("SELECT active_job_id FROM profiles WHERE profile_id=?", (profile,)).fetchone()[0] == "audio_job"
        assert conn.execute("SELECT COUNT(*) FROM profile_readers").fetchone()[0] == 0


def test_shared_browser_opens_once_and_closing_one_lease_keeps_the_other_alive(tmp_path, monkeypatch):
    settings, profile = setup(tmp_path)
    calls = {"launch": 0, "close": 0, "stop": 0}
    class Context:
        async def close(self): calls["close"] += 1
    class Driver:
        async def stop(self): calls["stop"] += 1
    async def launch(*_args):
        calls["launch"] += 1
        await asyncio.sleep(0)
        return Context(), Driver()
    monkeypatch.setattr("app.browser.context_manager._launch_context", launch)
    async def scenario():
        manager = BrowserContextManager(settings)
        first, second = await asyncio.gather(manager.open_context(profile), manager.open_context(profile))
        assert first.context is second.context
        await first.close(); await first.close()
        assert calls == {"launch": 1, "close": 0, "stop": 0}
        await second.close()
        assert calls == {"launch": 1, "close": 1, "stop": 1}
        await shutdown_browser_contexts()
    asyncio.run(scenario())


def test_new_open_waits_for_last_close_instead_of_racing_chromium_profile_files(tmp_path, monkeypatch):
    settings, profile = setup(tmp_path)
    async def scenario():
        closing = asyncio.Event(); finish = asyncio.Event(); launches = []
        class Context:
            async def close(self): closing.set(); await finish.wait()
        class Driver:
            async def stop(self): pass
        async def launch(*_args):
            launches.append(1); return Context(), Driver()
        monkeypatch.setattr("app.browser.context_manager._launch_context", launch)
        manager = BrowserContextManager(settings)
        first = await manager.open_context(profile)
        close = asyncio.create_task(first.close())
        await closing.wait()
        opening = asyncio.create_task(manager.open_context(profile))
        await asyncio.sleep(0)
        assert len(launches) == 1
        finish.set(); await close
        second = await opening
        assert len(launches) == 2
        await second.close(); await shutdown_browser_contexts()
    asyncio.run(scenario())


def test_lease_closes_its_own_page_without_closing_another_users_browser(tmp_path, monkeypatch):
    settings, profile = setup(tmp_path)
    calls = {"pages": 0, "browser": 0}
    class Page:
        async def close(self): calls["pages"] += 1
    class Context:
        async def new_page(self): return Page()
        async def close(self): calls["browser"] += 1
    class Driver:
        async def stop(self): pass
    async def launch(*_args): return Context(), Driver()
    monkeypatch.setattr("app.browser.context_manager._launch_context", launch)
    async def scenario():
        manager = BrowserContextManager(settings)
        job = await manager.open_context(profile)
        reader = await manager.open_context(profile)
        await job.new_page()
        await job.close()
        assert calls == {"pages": 1, "browser": 0}
        await reader.close()
        assert calls["browser"] == 1
        await shutdown_browser_contexts()
    asyncio.run(scenario())


def test_repeated_login_start_reuses_only_its_pending_qr_session(tmp_path, monkeypatch):
    import time
    from types import SimpleNamespace
    from app.profile_manager import start_login
    settings, profile = setup(tmp_path)
    qr = settings.profiles_dir / profile / "qr.png"
    qr.write_bytes(b"fake-qr")
    async def scenario():
        task = asyncio.create_task(asyncio.Event().wait())
        runtime = SimpleNamespace(profile_id=profile, settings=settings, expires_at_monotonic=time.monotonic()+60,
                                  task=task, qr_path=qr, login_session_id="ls_1234567890abcdef")
        monkeypatch.setattr("app.profile_manager._LOGIN_RUNTIMES", {"existing": runtime})
        try:
            first = await start_login(profile, "owner", settings)
            second = await start_login(profile, "owner", settings)
            assert first["login_session_id"] == second["login_session_id"] == runtime.login_session_id
            assert first["status"] == "pending"
            with pytest.raises(ProfileOwnershipError):
                await start_login(profile, "other", settings)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())
