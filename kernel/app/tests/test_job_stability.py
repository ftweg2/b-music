import asyncio
from dataclasses import replace

import pytest
from fastapi import HTTPException

from app.config import get_settings
from app.db import get_connection, init_db
from app.job_manager import create_job, run_job, get_job_status, JobConflictError, JobNotFoundError, recover_interrupted_runtime
from app.profile_manager import create_or_get_profile, ProfileOwnershipError
from app.schemas import JobCreateRequest
from app.strategies.base import StrategyResult


def setup(tmp_path, **overrides):
    settings = replace(get_settings(), data_dir=tmp_path, db_path=tmp_path / "kernel.sqlite3",
                       artifacts_dir=tmp_path / "artifacts", profiles_dir=tmp_path / "profiles", **overrides)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    request = JobCreateRequest(job_id="job_stability", external_owner_id="owner", profile_id=profile["profile_id"],
                               url="BV1GJ411x7h7", strategy_mode="force", strategy="api_dash", outputs=["raw"])
    return settings, profile, request


def lock_value(settings, profile):
    with get_connection(settings) as conn:
        return conn.execute("SELECT active_job_id FROM profiles WHERE profile_id=?", (profile["profile_id"],)).fetchone()["active_job_id"]


def test_identical_submission_reuses_job_without_recreating_artifacts(tmp_path):
    settings, profile, request = setup(tmp_path)
    assert create_job(request, settings)["reused"] is False
    marker = settings.artifacts_dir / request.job_id / "keep.txt"
    marker.write_text("keep")
    assert create_job(request, settings)["reused"] is True
    assert marker.read_text() == "keep"
    assert lock_value(settings, profile) == request.job_id
    with pytest.raises(JobConflictError):
        create_job(request.model_copy(update={"outputs": ["m4a"]}), settings)
    with pytest.raises(ProfileOwnershipError):
        create_job(request.model_copy(update={"external_owner_id": "another"}), settings)


def test_duplicate_runners_do_not_execute_twice_or_release_the_live_lock(tmp_path, monkeypatch):
    settings, profile, request = setup(tmp_path)
    create_job(request, settings)
    runs = []

    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()
        class Strategy:
            def supports(self, _context): return True
            async def run(self, _context):
                runs.append(1); started.set()
                await release.wait()
                return StrategyResult.failed(failure_code="TEST", reason="expected")
        monkeypatch.setattr("app.job_manager.strategy_registry", lambda: {"api_dash": Strategy()})
        first = asyncio.create_task(run_job(request.job_id, settings))
        await started.wait()
        await run_job(request.job_id, settings)
        assert len(runs) == 1
        assert lock_value(settings, profile) == request.job_id
        release.set()
        await first
        await run_job(request.job_id, settings)
    asyncio.run(scenario())
    assert len(runs) == 1
    assert lock_value(settings, profile) is None
    assert get_job_status(request.job_id, settings)["status"] == "failed"


def test_total_timeout_stops_hung_strategy_and_releases_profile(tmp_path, monkeypatch):
    settings, profile, request = setup(tmp_path, job_timeout_seconds=0.04)
    create_job(request, settings)
    cleaned = []
    class Hung:
        def supports(self, _context): return True
        async def run(self, _context):
            try: await asyncio.Future()
            finally: cleaned.append(True)
    monkeypatch.setattr("app.job_manager.strategy_registry", lambda: {"api_dash": Hung()})
    asyncio.run(run_job(request.job_id, settings))
    status = get_job_status(request.job_id, settings)
    assert status["status"] == "failed"
    assert "time limit" in status["sanitized_error"]
    assert cleaned and lock_value(settings, profile) is None


def test_report_write_failure_does_not_leave_a_running_job(tmp_path, monkeypatch):
    settings, profile, request = setup(tmp_path)
    create_job(request, settings)
    class Failure:
        def supports(self, _context): return True
        async def run(self, _context):
            return StrategyResult.failed(failure_code="TEST", reason="original error")
    monkeypatch.setattr("app.job_manager.strategy_registry", lambda: {"api_dash": Failure()})
    def no_space(*_args, **_kwargs): raise OSError("disk full")
    monkeypatch.setattr("app.job_manager._write_failure_artifacts", no_space)
    asyncio.run(run_job(request.job_id, settings))
    assert get_job_status(request.job_id, settings)["status"] == "failed"
    assert lock_value(settings, profile) is None


def test_unexpected_strategy_exception_is_recorded_and_allows_configured_fallback(tmp_path, monkeypatch):
    settings, profile, request = setup(tmp_path)
    request = request.model_copy(update={"strategy_mode": "auto", "strategy": None, "strategy_order": ["api_dash", "browser_network"]})
    create_job(request, settings)
    class Unexpected:
        def supports(self, _context): return True
        async def run(self, _context): raise ValueError("unexpected provider response")
    class Fallback:
        def supports(self, _context): return True
        async def run(self, _context): return StrategyResult.failed(failure_code="TEST", reason="fallback was attempted")
    monkeypatch.setattr("app.job_manager.strategy_registry", lambda: {"api_dash": Unexpected(), "browser_network": Fallback()})
    asyncio.run(run_job(request.job_id, settings))
    status = get_job_status(request.job_id, settings)
    assert [item["strategy_name"] for item in status["fallback_attempts"]] == ["api_dash", "browser_network"]
    assert status["fallback_attempts"][0]["failure_code"] == "STRATEGY_EXCEPTION"
    assert lock_value(settings, profile) is None


def test_startup_recovery_survives_report_write_failure(tmp_path, monkeypatch):
    settings, profile, request = setup(tmp_path)
    create_job(request, settings)
    def no_space(*_args, **_kwargs): raise OSError("disk full")
    monkeypatch.setattr("app.job_manager._write_failure_artifacts", no_space)
    assert recover_interrupted_runtime(settings)["jobs_marked_failed"] == 1
    assert get_job_status(request.job_id, settings)["status"] == "failed"
    assert lock_value(settings, profile) is None


def test_admission_limit_rejects_new_work_but_accepts_idempotent_retry(tmp_path, monkeypatch):
    from app.routers import jobs
    settings, _profile, request = setup(tmp_path, max_active_jobs=1)
    created = []
    monkeypatch.setattr(jobs, "get_settings", lambda: settings)
    def missing(*_args): raise JobNotFoundError("missing")
    monkeypatch.setattr(jobs, "verify_job_owner", missing)
    monkeypatch.setattr(jobs, "create_job", lambda _request: created.append(1))

    async def scenario():
        task = asyncio.create_task(asyncio.Event().wait())
        monkeypatch.setattr(jobs, "_job_tasks", {task})
        try:
            with pytest.raises(HTTPException) as failure:
                await jobs.submit_job(request)
            assert failure.value.status_code == 503
            assert failure.value.headers["Retry-After"] == "3"
            assert not created
            monkeypatch.setattr(jobs, "verify_job_owner", lambda *_args: {})
            monkeypatch.setattr(jobs, "create_job", lambda _request: {"job_id": request.job_id, "status": "running_api_dash", "stage": "running_api_dash", "reused": True})
            assert (await jobs.submit_job(request))["reused"] is True
            assert len(jobs._job_tasks) == 1
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())


def test_shutdown_wait_is_bounded(tmp_path, monkeypatch):
    from app.routers import jobs
    settings, _profile, _request = setup(tmp_path, shutdown_grace_seconds=0.01)
    monkeypatch.setattr(jobs, "get_settings", lambda: settings)
    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()
        async def worker():
            started.set()
            try: await asyncio.Future()
            except asyncio.CancelledError: await release.wait()
        task = asyncio.create_task(worker())
        await started.wait()
        monkeypatch.setattr(jobs, "_job_tasks", {task})
        await asyncio.wait_for(jobs.shutdown_job_tasks(), 0.3)
        release.set()
        await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())


def test_stability_limits_are_bounded(monkeypatch):
    monkeypatch.setenv("MAX_ACTIVE_JOBS", "9999")
    monkeypatch.setenv("JOB_TIMEOUT_SECONDS", "nan")
    monkeypatch.setenv("SHUTDOWN_GRACE_SECONDS", "0")
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.max_active_jobs == 8
        assert settings.job_timeout_seconds == 300
        assert settings.shutdown_grace_seconds == 1
    finally: get_settings.cache_clear()


def test_cancellation_drains_cooperative_media_worker_before_releasing_lock(tmp_path, monkeypatch):
    import threading
    import time
    from app.strategies.base import StrategyCancelled
    settings, profile, request = setup(tmp_path)
    create_job(request, settings)
    started = threading.Event()
    stopped = threading.Event()
    class Raw:
        def supports(self, _context): return True
        async def run(self, context):
            raw = context.job_dir / "raw.m4s"
            raw.write_bytes(b"test-audio")
            return StrategyResult.succeeded(reason="raw ready", selected_media={}, raw_artifacts=[raw], timings={})
    def process(context, *_args):
        started.set()
        while not context.cancel_requested():
            time.sleep(0.005)
        stopped.set()
        raise StrategyCancelled("cancelled test worker")
    monkeypatch.setattr("app.job_manager.strategy_registry", lambda: {"api_dash": Raw()})
    monkeypatch.setattr("app.job_manager._process_successful_result", process)
    async def scenario():
        task = asyncio.create_task(run_job(request.job_id, settings))
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set()
    asyncio.run(scenario())
    assert lock_value(settings, profile) is None
    assert get_job_status(request.job_id, settings)["status"] == "cancelled"


def test_cancelling_a_queued_task_still_runs_its_lock_cleanup(tmp_path, monkeypatch):
    from app.routers import jobs
    from app.schemas import JobAccessRequest
    settings, profile, request = setup(tmp_path)
    monkeypatch.setattr("app.job_manager.get_settings", lambda: settings)
    monkeypatch.setattr(jobs, "get_settings", lambda: settings)
    monkeypatch.setattr(jobs, "_job_tasks", set())
    async def scenario():
        await jobs.submit_job(request)
        tasks = list(jobs._job_tasks)
        assert get_job_status(request.job_id, settings)["status"] == "queued"
        assert (await jobs.cancel_job(request.job_id, JobAccessRequest(external_owner_id="owner")))["status"] == "cancel_requested"
        await asyncio.gather(*tasks, return_exceptions=True)
    asyncio.run(scenario())
    assert get_job_status(request.job_id, settings)["status"] == "cancelled"
    assert lock_value(settings, profile) is None
