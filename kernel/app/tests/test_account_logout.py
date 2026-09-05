import asyncio
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.config import get_settings
from app.db import init_db
from app.profile_manager import (
    create_or_get_profile, profile_storage_dir, logout_profile, get_login_status,
    update_login_metadata, lock_profile, get_profile, ProfileLockedError, ProfileOwnershipError,
)

def setup(tmp_path):
    settings = replace(get_settings(), data_dir=tmp_path, db_path=tmp_path / "kernel.sqlite3",
                       artifacts_dir=tmp_path / "artifacts", profiles_dir=tmp_path / "profiles")
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    auth = profile_storage_dir(profile["profile_id"], settings) / "Default" / "Cookies"
    auth.parent.mkdir(); auth.write_text("fake session for isolated test")
    update_login_metadata(profile["profile_id"], logged_in=True, bili_uid="1001", nickname="test account", settings=settings)
    return settings, profile, auth

def test_logout_clears_only_selected_profile_and_keeps_kernel_database_and_artifacts(tmp_path):
    settings, profile, auth = setup(tmp_path)
    other = create_or_get_profile("other", settings)
    sibling = profile_storage_dir(other["profile_id"], settings) / "keep"
    sibling.write_text("other session")
    artifact = settings.artifacts_dir / "keep.m4a"; artifact.write_bytes(b"keep audio")
    result = asyncio.run(logout_profile(profile["profile_id"], "owner", settings))
    assert result["logged_in"] is False
    assert not auth.exists()
    assert sibling.read_text() == "other session"
    assert artifact.read_bytes() == b"keep audio" and settings.db_path.is_file()
    assert get_login_status(profile["profile_id"], settings)["bili_uid"] is None
    assert get_profile(profile["profile_id"], settings)["active_job_id"] is None
    assert asyncio.run(logout_profile(profile["profile_id"], "owner", settings))["logged_in"] is False

def test_logout_refuses_another_owner_without_modifying_credentials(tmp_path):
    settings, profile, auth = setup(tmp_path)
    with pytest.raises(ProfileOwnershipError):
        asyncio.run(logout_profile(profile["profile_id"], "other", settings))
    assert auth.exists() and get_login_status(profile["profile_id"], settings)["logged_in"]

def test_logout_refuses_active_audio_or_search_locks(tmp_path):
    settings, profile, auth = setup(tmp_path)
    lock_profile(profile["profile_id"], "active_audio_job", settings)
    with pytest.raises(ProfileLockedError):
        asyncio.run(logout_profile(profile["profile_id"], "owner", settings))
    assert auth.exists()
    assert get_profile(profile["profile_id"], settings)["active_job_id"] == "active_audio_job"

def test_logout_rejects_escaped_profile_paths_and_releases_its_lock(tmp_path, monkeypatch):
    settings, profile, auth = setup(tmp_path)
    outside = tmp_path / "outside"; outside.mkdir(); marker = outside / "keep"; marker.write_text("safe")
    monkeypatch.setattr("app.profile_manager.profile_storage_dir", lambda *_args: outside)
    with pytest.raises(ValueError, match="unsafe"):
        asyncio.run(logout_profile(profile["profile_id"], "owner", settings))
    assert marker.exists() and auth.exists()
    assert get_profile(profile["profile_id"], settings)["active_job_id"] is None

def test_failed_cleanup_does_not_claim_successful_logout(tmp_path, monkeypatch):
    settings, profile, auth = setup(tmp_path)
    def denied(_path): raise PermissionError("locked files")
    monkeypatch.setattr("app.profile_manager.shutil.rmtree", denied)
    with pytest.raises(PermissionError):
        asyncio.run(logout_profile(profile["profile_id"], "owner", settings))
    assert auth.exists() and get_login_status(profile["profile_id"], settings)["logged_in"]
    assert get_profile(profile["profile_id"], settings)["active_job_id"] is None

def test_logout_refuses_misconfigured_artifact_storage_inside_the_profile(tmp_path):
    settings, profile, auth = setup(tmp_path)
    protected = auth.parent / "artifacts"; protected.mkdir()
    bad_settings = replace(settings, artifacts_dir=protected)
    with pytest.raises(ValueError, match="protected"):
        asyncio.run(logout_profile(profile["profile_id"], "owner", bad_settings))
    assert auth.exists() and protected.exists()

def test_logout_closes_pending_login_watcher_before_clearing_files(tmp_path, monkeypatch):
    from app.profile_manager import release_profile_lock
    settings, profile, auth = setup(tmp_path)
    closed = []
    class Managed:
        async def close(self): closed.append(True)
    async def scenario():
        started = asyncio.Event()
        lock_profile(profile["profile_id"], "login_pending", settings)
        async def watch():
            started.set()
            try: await asyncio.Future()
            finally: release_profile_lock(profile["profile_id"], "login_pending", settings)
        task = asyncio.create_task(watch())
        await started.wait()
        runtime = SimpleNamespace(profile_id=profile["profile_id"], settings=settings, task=task, managed=Managed())
        monkeypatch.setattr("app.profile_manager._LOGIN_RUNTIMES", {"pending": runtime})
        await logout_profile(profile["profile_id"], "owner", settings)
        assert task.done() and closed
    asyncio.run(scenario())
    assert not auth.exists()
