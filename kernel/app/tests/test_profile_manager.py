import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier
from contextlib import contextmanager

import pytest

from app.config import Settings, get_settings
from app.db import get_connection, init_db
from app.models import LoginStatus
from app.profile_manager import (
    CookieImportError,
    create_or_get_profile,
    get_login_qr_image_path,
    import_cookies_to_profile,
    parse_cookie_import,
    start_login,
)


def test_create_or_get_profile_is_atomic_for_concurrent_requests(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    worker_count = 8
    barrier = Barrier(worker_count)

    def create_profile() -> dict[str, str]:
        barrier.wait()
        return create_or_get_profile("concurrent-owner", settings)

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        results = list(executor.map(lambda _: create_profile(), range(worker_count)))

    profile_ids = {result["profile_id"] for result in results}
    statuses = [result["status"] for result in results]

    assert len(profile_ids) == 1
    assert statuses.count("created") == 1
    assert statuses.count("exists") == worker_count - 1

    profile_id = next(iter(profile_ids))
    with get_connection(settings) as conn:
        rows = conn.execute(
            "SELECT profile_id, external_owner_id FROM profiles WHERE external_owner_id=?",
            ("concurrent-owner",),
        ).fetchall()
    assert [dict(row) for row in rows] == [
        {"profile_id": profile_id, "external_owner_id": "concurrent-owner"}
    ]
    assert (settings.profiles_dir / profile_id).is_dir()


def make_settings(tmp_path) -> Settings:
    return replace(
        get_settings(),
        data_dir=tmp_path,
        db_path=tmp_path / "kernel.sqlite3",
        artifacts_dir=tmp_path / "artifacts",
        profiles_dir=tmp_path / "profiles",
    )


def test_existing_profile_lookup_does_not_take_a_write_transaction(tmp_path, monkeypatch):
    import app.profile_manager as profiles
    settings = make_settings(tmp_path)
    init_db(settings)
    first = create_or_get_profile("read-only-owner", settings)
    statements = []
    original = profiles.get_connection

    @contextmanager
    def traced(settings=None):
        with original(settings) as conn:
            conn.set_trace_callback(statements.append)
            yield conn

    monkeypatch.setattr(profiles, "get_connection", traced)
    repeated = create_or_get_profile("read-only-owner", settings)
    assert repeated["profile_id"] == first["profile_id"]
    assert repeated["status"] == "exists"
    assert not any(sql.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE", "BEGIN")) for sql in statements)


def test_login_qr_is_not_readable_after_session_terminal(tmp_path) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)
    login_session_id = "ls_1234567890abcdef"
    qr_dir = settings.profiles_dir / profile["profile_id"] / "login_sessions" / login_session_id
    qr_dir.mkdir(parents=True)
    (qr_dir / "qr.png").write_bytes(b"fake-qr")
    with get_connection(settings) as conn:
        conn.execute(
            "INSERT INTO login_sessions (login_session_id, profile_id, status, message, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
            (login_session_id, profile["profile_id"], LoginStatus.LOGGED_OUT, "done"),
        )

    with pytest.raises(FileNotFoundError):
        get_login_qr_image_path(
            profile_id=profile["profile_id"],
            login_session_id=login_session_id,
            external_owner_id="owner",
            settings=settings,
        )


@pytest.mark.parametrize(
    "payload",
    [
        [{"name": "a", "value": "x" * 16_385}],
        [{"name": str(index), "value": "x"} for index in range(257)],
    ],
)
def test_cookie_import_rejects_oversized_entries(payload) -> None:
    with pytest.raises(CookieImportError):
        parse_cookie_import("json", payload)


def test_storage_state_import_rejects_oversized_local_storage(tmp_path) -> None:
    with pytest.raises(CookieImportError, match="localStorage"):
        parse_cookie_import(
            "playwright_storage_state",
            {
                "cookies": [],
                "origins": [
                    {
                        "origin": "https://www.bilibili.com",
                        "localStorage": [
                            {"name": "oversized", "value": "x" * 65_537}
                        ],
                    }
                ],
            },
        )


def test_cancelled_login_start_releases_profile_lock(tmp_path, monkeypatch) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)

    class CancelledBrowserContextManager:
        def __init__(self, _settings) -> None:
            pass

        async def open_request_context(self, _profile_id):
            raise asyncio.CancelledError

    monkeypatch.setattr(
        "app.browser.context_manager.BrowserContextManager",
        CancelledBrowserContextManager,
    )

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(start_login(profile["profile_id"], "owner", settings))

    with get_connection(settings) as conn:
        stored_profile = conn.execute(
            "SELECT active_job_id, login_status FROM profiles WHERE profile_id=?",
            (profile["profile_id"],),
        ).fetchone()
        session = conn.execute(
            "SELECT status FROM login_sessions WHERE profile_id=?",
            (profile["profile_id"],),
        ).fetchone()
    assert stored_profile["active_job_id"] is None
    assert stored_profile["login_status"] == LoginStatus.LOGGED_OUT
    assert session["status"] == LoginStatus.LOGGED_OUT


def test_cookie_import_close_failure_still_releases_profile_lock(
    tmp_path, monkeypatch
) -> None:
    settings = make_settings(tmp_path)
    init_db(settings)
    profile = create_or_get_profile("owner", settings)

    class FakeContext:
        async def add_cookies(self, _cookies) -> None:
            pass

    class CloseFailureManaged:
        context = FakeContext()

        async def close(self) -> None:
            raise RuntimeError("expected close failure")

    class FakeBrowserContextManager:
        def __init__(self, _settings) -> None:
            pass

        async def open_context(self, _profile_id):
            return CloseFailureManaged()

    async def fake_identity(_context, _settings):
        return {"logged_in": False, "bili_uid": None, "nickname": None}

    monkeypatch.setattr(
        "app.browser.context_manager.BrowserContextManager",
        FakeBrowserContextManager,
    )
    monkeypatch.setattr("app.profile_manager._verify_bilibili_identity", fake_identity)

    with pytest.raises(RuntimeError, match="expected close failure"):
        asyncio.run(
            import_cookies_to_profile(
                profile_id=profile["profile_id"],
                external_owner_id="owner",
                format_name="cookie_header",
                cookies_payload="SESSDATA=fake-value",
                settings=settings,
            )
        )

    with get_connection(settings) as conn:
        stored = conn.execute(
            "SELECT active_job_id FROM profiles WHERE profile_id=?",
            (profile["profile_id"],),
        ).fetchone()
    assert stored["active_job_id"] is None
