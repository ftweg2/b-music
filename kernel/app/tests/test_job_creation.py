import asyncio
from dataclasses import replace

import pytest

from app.config import Settings, get_settings
from app.db import get_connection, init_db
from app.job_manager import (
    JobConflictError,
    create_job,
    get_job_status,
    recover_interrupted_runtime,
    request_cancel,
    run_job,
    verify_job_owner,
)
from app.models import JobState
from app.profile_manager import (
    ProfileLockedError,
    ProfileNotFoundError,
    ProfileOwnershipError,
    create_or_get_profile,
    lock_profile,
)
from app.schemas import JobCreateRequest
from app.strategies.base import StrategyResult


def test_rejected_job_does_not_leave_artifact_directory(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    request = job_request("job_missing_profile", "p_123456789012")

    with pytest.raises(ProfileNotFoundError):
        create_job(request, settings)

    assert not (settings.artifacts_dir / request.job_id).exists()


def test_profile_lock_is_claimed_conditionally_without_artifact_leak(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    lock_profile(profile["profile_id"], "existing_job", settings)
    request = job_request("job_blocked", profile["profile_id"])

    with pytest.raises(ProfileLockedError):
        create_job(request, settings)

    assert not (settings.artifacts_dir / request.job_id).exists()
    with get_connection(settings) as conn:
        stored = conn.execute("SELECT job_id FROM jobs WHERE job_id=?", (request.job_id,)).fetchone()
        active_job = conn.execute(
            "SELECT active_job_id FROM profiles WHERE profile_id=?", (profile["profile_id"],)
        ).fetchone()
    assert stored is None
    assert active_job["active_job_id"] == "existing_job"


def test_created_job_owns_profile_and_artifact_directory(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    request = job_request("job_created", profile["profile_id"])

    response = create_job(request, settings)

    assert response["status"] == "queued"
    assert (settings.artifacts_dir / request.job_id).is_dir()
    with get_connection(settings) as conn:
        active_job = conn.execute(
            "SELECT active_job_id FROM profiles WHERE profile_id=?", (profile["profile_id"],)
        ).fetchone()
    assert active_job["active_job_id"] == request.job_id
    with get_connection(settings) as conn:
        stored_job = conn.execute(
            "SELECT url FROM jobs WHERE job_id=?", (request.job_id,)
        ).fetchone()
    assert stored_job["url"] == "https://www.bilibili.com/video/BV1GJ411x7h7"


def test_existing_artifact_directory_rejects_job_and_releases_profile(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    request = job_request("job_orphaned", profile["profile_id"])
    orphan = settings.artifacts_dir / request.job_id
    orphan.mkdir(parents=True)

    with pytest.raises(JobConflictError):
        create_job(request, settings)

    assert orphan.is_dir()
    with get_connection(settings) as conn:
        stored = conn.execute("SELECT job_id FROM jobs WHERE job_id=?", (request.job_id,)).fetchone()
        active_job = conn.execute(
            "SELECT active_job_id FROM profiles WHERE profile_id=?", (profile["profile_id"],)
        ).fetchone()
    assert stored is None
    assert active_job["active_job_id"] is None


def test_cancel_terminal_job_is_idempotent(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    request = job_request("job_terminal", profile["profile_id"])
    create_job(request, settings)
    with get_connection(settings) as conn:
        conn.execute(
            "UPDATE jobs SET status=?, stage=? WHERE job_id=?",
            (JobState.SUCCEEDED, JobState.SUCCEEDED, request.job_id),
        )

    response = request_cancel(request.job_id, settings)

    assert response == {"job_id": request.job_id, "status": JobState.SUCCEEDED}
    with get_connection(settings) as conn:
        row = conn.execute(
            "SELECT cancel_requested FROM jobs WHERE job_id=?", (request.job_id,)
        ).fetchone()
    assert row["cancel_requested"] == 0


def test_verify_job_owner_rejects_cross_owner_access(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    request = job_request("job_owned", profile["profile_id"])
    create_job(request, settings)

    with pytest.raises(ProfileOwnershipError):
        verify_job_owner(request.job_id, "different-owner", settings)


def test_cancel_requested_after_last_strategy_failure_wins_terminal_race(
    tmp_path, monkeypatch
) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    request = job_request("job_cancelled_after_failure", profile["profile_id"])
    request.strategy_mode = "force"
    request.strategy = "api_dash"
    create_job(request, settings)

    class CancellingFailureStrategy:
        name = "api_dash"

        def supports(self, _context) -> bool:
            return True

        async def run(self, _context) -> StrategyResult:
            request_cancel(request.job_id, settings)
            return StrategyResult.failed(
                failure_code="EXPECTED_FAILURE",
                reason="expected strategy failure",
            )

    monkeypatch.setattr(
        "app.job_manager.strategy_registry",
        lambda: {"api_dash": CancellingFailureStrategy()},
    )

    asyncio.run(run_job(request.job_id, settings))

    status = get_job_status(request.job_id, settings)
    assert status["status"] == JobState.CANCELLED
    assert status["stage"] == JobState.CANCELLED


def test_recovery_writes_failure_artifacts(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    request = job_request("job_recovered", profile["profile_id"])
    create_job(request, settings)

    result = recover_interrupted_runtime(settings)

    assert result["jobs_marked_failed"] == 1
    job_dir = settings.artifacts_dir / request.job_id
    assert (job_dir / "artifact_manifest.json").is_file()
    assert (job_dir / "metadata.json").is_file()
    assert (job_dir / "strategy_report.json").is_file()
    with get_connection(settings) as conn:
        row = conn.execute(
            "SELECT status FROM jobs WHERE job_id=?", (request.job_id,)
        ).fetchone()
        artifacts = conn.execute(
            "SELECT name FROM artifacts WHERE job_id=? ORDER BY name", (request.job_id,)
        ).fetchall()
    assert row["status"] == JobState.FAILED
    assert {item["name"] for item in artifacts} == {
        "artifact_manifest.json",
        "metadata.json",
        "strategy_report.json",
    }


def test_missing_requested_m4a_fails_job_but_preserves_raw_artifact(
    tmp_path, monkeypatch
) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    request = job_request("job_missing_requested_m4a", profile["profile_id"])
    request.strategy_mode = "force"
    request.strategy = "api_dash"
    create_job(request, settings)

    class SuccessfulRawStrategy:
        name = "api_dash"

        def supports(self, _context) -> bool:
            return True

        async def run(self, context) -> StrategyResult:
            raw_path = context.job_dir / "raw.m4s"
            raw_path.write_bytes(b"raw-audio")
            return StrategyResult.succeeded(
                reason="raw extraction succeeded",
                selected_media={},
                raw_artifacts=[raw_path],
                timings={},
            )

    monkeypatch.setattr(
        "app.job_manager.strategy_registry",
        lambda: {"api_dash": SuccessfulRawStrategy()},
    )
    monkeypatch.setattr("app.media_pipeline.shutil.which", lambda _name: None)

    asyncio.run(run_job(request.job_id, settings))

    status = get_job_status(request.job_id, settings)
    assert status["status"] == JobState.FAILED
    assert "audio.m4a" in status["sanitized_error"]
    with get_connection(settings) as conn:
        artifacts = conn.execute(
            "SELECT name, sha256 FROM artifacts WHERE job_id=? ORDER BY name",
            (request.job_id,),
        ).fetchall()
    artifact_names = {item["name"] for item in artifacts}
    assert artifact_names == {
        "artifact_manifest.json",
        "metadata.json",
        "raw.m4s",
        "strategy_report.json",
    }
    assert all(len(item["sha256"]) == 64 for item in artifacts)


def make_settings(tmp_path) -> Settings:
    return replace(
        get_settings(),
        data_dir=tmp_path,
        db_path=tmp_path / "kernel.sqlite3",
        artifacts_dir=tmp_path / "artifacts",
        profiles_dir=tmp_path / "profiles",
    )


def job_request(job_id: str, profile_id: str) -> JobCreateRequest:
    return JobCreateRequest(
        job_id=job_id,
        external_owner_id="owner",
        profile_id=profile_id,
        url="https://www.bilibili.com/video/BV1GJ411x7h7",
        strategy_mode="auto",
        outputs=["m4a"],
    )
