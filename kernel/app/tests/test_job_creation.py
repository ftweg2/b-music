from dataclasses import replace

import pytest

from app.config import Settings, get_settings
from app.db import get_connection, init_db
from app.job_manager import JobConflictError, create_job
from app.profile_manager import (
    ProfileLockedError,
    ProfileNotFoundError,
    create_or_get_profile,
    lock_profile,
)
from app.schemas import JobCreateRequest


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
