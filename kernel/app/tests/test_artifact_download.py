from dataclasses import replace
import hashlib

from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import get_connection, init_db
from app.job_manager import create_job
from app.main import app
from app.profile_manager import create_or_get_profile
from app.schemas import JobCreateRequest


def test_artifact_download_supports_head_range_and_checksum(tmp_path, monkeypatch) -> None:
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
            job_id="job_download_contract",
            external_owner_id="owner",
            profile_id=profile["profile_id"],
            url="BV1GJ411x7h7",
            outputs=["m4a"],
        ),
        settings,
    )
    payload = b"0123456789"
    artifact_dir = settings.artifacts_dir / "job_download_contract"
    artifact_path = artifact_dir / "audio.m4a"
    artifact_path.write_bytes(payload)
    sha256 = hashlib.sha256(payload).hexdigest()
    with get_connection(settings) as conn:
        conn.execute(
            """
            INSERT INTO artifacts (
                job_id, name, path, type, size_bytes, sha256, created_at,
                producer_strategy, mime_guess
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "job_download_contract",
                "audio.m4a",
                str(artifact_path),
                "m4a",
                len(payload),
                sha256,
                "2026-08-13T00:00:00+00:00",
                "test",
                "audio/mp4",
            ),
        )

    monkeypatch.setattr("app.job_manager.get_settings", lambda: settings)
    client = TestClient(app)
    params = {"external_owner_id": "owner"}

    head = client.head(
        "/v1/jobs/job_download_contract/artifacts/audio.m4a", params=params
    )
    assert head.status_code == 200
    assert head.content == b""
    assert head.headers["content-length"] == str(len(payload))
    assert head.headers["accept-ranges"] == "bytes"
    assert head.headers["x-content-sha256"] == sha256
    assert head.headers["etag"] == f'"sha256-{sha256}"'

    partial = client.get(
        "/v1/jobs/job_download_contract/artifacts/audio.m4a",
        params=params,
        headers={"range": "bytes=2-5"},
    )
    assert partial.status_code == 206
    assert partial.content == b"2345"
    assert partial.headers["content-range"] == "bytes 2-5/10"
    assert partial.headers["x-content-sha256"] == sha256

    resumed = client.get(
        "/v1/jobs/job_download_contract/artifacts/audio.m4a",
        params=params,
        headers={"range": "bytes=6-", "if-range": f'"sha256-{sha256}"'},
    )
    assert resumed.status_code == 206
    assert resumed.content == b"6789"

    changed = client.get(
        "/v1/jobs/job_download_contract/artifacts/audio.m4a",
        params=params,
        headers={"range": "bytes=6-", "if-range": '"sha256-old"'},
    )
    assert changed.status_code == 200
    assert changed.content == payload

    unsatisfied = client.get(
        "/v1/jobs/job_download_contract/artifacts/audio.m4a",
        params=params,
        headers={"range": "bytes=99-100"},
    )
    assert unsatisfied.status_code == 416
    assert unsatisfied.headers["content-range"] == "bytes */10"

    with get_connection(settings) as conn:
        conn.execute(
            "UPDATE artifacts SET path=? WHERE job_id=? AND name=?",
            (
                "/data/artifacts/job_download_contract/audio.m4a",
                "job_download_contract",
                "audio.m4a",
            ),
        )
    relocated = client.head(
        "/v1/jobs/job_download_contract/artifacts/audio.m4a", params=params
    )
    assert relocated.status_code == 200
    assert relocated.headers["x-content-sha256"] == sha256

    denied = client.head(
        "/v1/jobs/job_download_contract/artifacts/audio.m4a",
        params={"external_owner_id": "different-owner"},
    )
    assert denied.status_code == 403
