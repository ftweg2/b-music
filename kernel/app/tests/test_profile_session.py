from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import init_db
from app.main import app
from app import profile_manager


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    settings = replace(get_settings(), data_dir=tmp_path, db_path=tmp_path / "kernel.sqlite3",
                       profiles_dir=tmp_path / "profiles", artifacts_dir=tmp_path / "artifacts")
    init_db(settings)
    monkeypatch.setattr(profile_manager, "get_settings", lambda: settings)
    return settings, TestClient(app)


def test_legacy_profile_response_is_unchanged_and_combined_identity_is_complete(isolated):
    _settings, client = isolated
    legacy = client.post("/v1/profiles", json={"external_owner_id": "owner"})
    assert legacy.status_code == 200
    assert set(legacy.json()) == {"profile_id", "external_owner_id", "status"}
    profile_id = legacy.json()["profile_id"]
    combined = client.post("/v1/profiles", json={"external_owner_id": "owner", "include_login_status": True})
    assert combined.status_code == 200
    assert combined.json()["status"] == "exists"
    assert combined.json()["login"] == client.get(
        f"/v1/profiles/{profile_id}/login/status", params={"external_owner_id": "owner"}
    ).json()
    assert combined.json()["login"]["bili_uid"] is None
    assert combined.json()["login"]["nickname"] is None


def test_combined_profile_reflects_each_account_change_without_reassigning_profile(isolated):
    settings, client = isolated
    request = {"external_owner_id": "owner", "include_login_status": True}
    initial = client.post("/v1/profiles", json=request).json()
    assert initial["status"] == "created"
    profile_id = initial["profile_id"]
    for uid, nickname in [("111", "first"), (None, None), ("222", "second")]:
        profile_manager.update_login_metadata(profile_id, logged_in=uid is not None,
                                              bili_uid=uid, nickname=nickname, settings=settings)
        current = client.post("/v1/profiles", json=request).json()
        assert current["profile_id"] == profile_id
        assert current["login"]["logged_in"] == (uid is not None)
        assert current["login"]["bili_uid"] == uid
        assert current["login"]["nickname"] == nickname
        assert current["login"]["last_verified_at"] is not None
    other = client.post("/v1/profiles", json={**request, "external_owner_id": "other"}).json()
    assert other["profile_id"] != profile_id
    assert other["login"]["bili_uid"] is None
    assert client.get(f"/v1/profiles/{profile_id}/login/status",
                      params={"external_owner_id": "other"}).status_code == 403


def test_existing_profile_and_identity_require_one_read_and_no_database_write(isolated, monkeypatch):
    settings, _client = isolated
    profile_manager.create_or_get_profile("owner", settings)
    original = profile_manager.get_connection
    connections, statements = [], []

    @contextmanager
    def traced(*args, **kwargs):
        with original(*args, **kwargs) as conn:
            connections.append(1)
            conn.set_trace_callback(statements.append)
            yield conn

    monkeypatch.setattr(profile_manager, "get_connection", traced)
    profile_manager.create_or_get_profile("owner", settings, include_login_status=True)
    assert len(connections) == 1
    assert len([sql for sql in statements if sql.lstrip().upper().startswith("SELECT")]) == 1
    assert not any(sql.lstrip().upper().startswith(("INSERT", "UPDATE", "BEGIN", "DELETE")) for sql in statements)


def test_simultaneous_first_resolutions_create_one_profile(isolated):
    settings, _client = isolated
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: profile_manager.create_or_get_profile(
            "simultaneous", settings, include_login_status=True), range(12)))
    assert len({item["profile_id"] for item in results}) == 1
    assert sum(item["status"] == "created" for item in results) == 1
    assert all(item["login"]["profile_id"] == item["profile_id"] for item in results)


def test_old_login_status_checks_owner_and_reads_identity_in_one_query(isolated, monkeypatch):
    settings, client = isolated
    profile = profile_manager.create_or_get_profile("owner", settings)
    original = profile_manager.get_profile
    reads = []

    def read(*args, **kwargs):
        reads.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(profile_manager, "get_profile", read)
    result = client.get(f"/v1/profiles/{profile['profile_id']}/login/status",
                        params={"external_owner_id": "owner"})
    assert result.status_code == 200
    assert reads == [1]
    assert not {"cookies", "active_job_id", "created_at", "updated_at"} & result.json().keys()
