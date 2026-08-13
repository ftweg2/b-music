from dataclasses import replace

from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import init_db
from app.job_manager import create_job
from app.main import app
from app.profile_manager import create_or_get_profile
from app.schemas import JobCreateRequest


def test_job_status_requires_and_verifies_owner(tmp_path, monkeypatch) -> None:
    settings = replace(
        get_settings(),
        data_dir=tmp_path,
        db_path=tmp_path / "kernel.sqlite3",
        artifacts_dir=tmp_path / "artifacts",
        profiles_dir=tmp_path / "profiles",
    )
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    create_job(
        JobCreateRequest(
            job_id="job_api_owner",
            external_owner_id="owner",
            profile_id=profile["profile_id"],
            url="BV1GJ411x7h7",
            outputs=["raw"],
        ),
        settings,
    )

    monkeypatch.setattr("app.routers.jobs.get_settings", lambda: settings, raising=False)
    monkeypatch.setattr("app.job_manager.get_settings", lambda: settings)
    client = TestClient(app)

    assert client.get("/v1/jobs/job_api_owner").status_code == 422
    denied = client.get(
        "/v1/jobs/job_api_owner", params={"external_owner_id": "different-owner"}
    )
    allowed = client.get(
        "/v1/jobs/job_api_owner", params={"external_owner_id": "owner"}
    )

    assert denied.status_code == 403
    assert allowed.status_code == 200
