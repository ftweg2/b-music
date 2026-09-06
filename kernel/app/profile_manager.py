from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import shutil
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from .config import Settings, get_settings
from .db import get_connection
from .models import LoginStatus, utc_now_iso
from .bilibili.qr_login import QRChallenge, LoginFlowError, create_qr, poll_qr
from .browser.responses import managed_response
from .security import (
    is_bilibili_host,
    sanitize_text,
    validate_external_owner_id,
    validate_login_session_id,
    validate_profile_id,
)


class ProfileNotFoundError(LookupError):
    pass


class ProfileOwnershipError(PermissionError):
    pass


class ProfileLockedError(RuntimeError):
    pass


class CookieImportError(RuntimeError):
    pass


@dataclass(frozen=True)
class CookieImportResult:
    profile_id: str
    status: str
    logged_in: bool
    bili_uid: str | None
    nickname: str | None
    last_verified_at: str | None
    message: str


@dataclass
class LoginRuntime:
    login_session_id: str
    profile_id: str
    lock_id: str
    qr_path: Path
    managed: Any
    challenge: QRChallenge
    settings: Settings
    expires_at_monotonic: float
    task: asyncio.Task[None] | None = None


_LOGIN_RUNTIMES: dict[str, LoginRuntime] = {}
_LOGIN_RUNTIME_LOCK: asyncio.Lock | None = None
_LOGIN_STARTS: dict[tuple[str, str], asyncio.Task] = {}

# Imported browser state is user-controlled input.  Keep the parser bounded so
# a single request cannot create an unbounded number of browser entries or
# force an oversized JSON payload into a Playwright context.
MAX_COOKIE_IMPORT_PAYLOAD_BYTES = 1 * 1024 * 1024
MAX_COOKIE_ENTRIES = 256
MAX_COOKIE_NAME_LENGTH = 256
MAX_COOKIE_VALUE_LENGTH = 16 * 1024
MAX_COOKIE_PATH_LENGTH = 4096
MAX_STORAGE_ORIGINS = 32
MAX_LOCAL_STORAGE_ENTRIES = 256
MAX_LOCAL_STORAGE_KEY_LENGTH = 1024
MAX_LOCAL_STORAGE_VALUE_LENGTH = 64 * 1024
MAX_LOCAL_STORAGE_TOTAL_BYTES = 512 * 1024


def _new_profile_id() -> str:
    return f"p_{uuid.uuid4().hex[:16]}"


def profile_storage_dir(profile_id: str, settings: Settings | None = None):
    settings = settings or get_settings()
    validate_profile_id(profile_id)
    return settings.profiles_dir / profile_id


def create_or_get_profile(
    external_owner_id: str,
    settings: Settings | None = None,
    *,
    include_login_status: bool = False,
) -> dict[str, object]:
    settings = settings or get_settings()
    validate_external_owner_id(external_owner_id)
    with get_connection(settings) as conn:
        profile = conn.execute(
            "SELECT * FROM profiles WHERE external_owner_id=?",
            (external_owner_id,),
        ).fetchone()
        status = "exists"
        if profile is None:
            now = utc_now_iso()
            candidate_profile_id = _new_profile_id()
            inserted = conn.execute(
                """
                INSERT INTO profiles (
                    profile_id, external_owner_id, login_status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(external_owner_id) DO NOTHING
                """,
                (candidate_profile_id, external_owner_id, LoginStatus.UNKNOWN, now, now),
            )
            profile = conn.execute(
                "SELECT * FROM profiles WHERE external_owner_id=?",
                (external_owner_id,),
            ).fetchone()
            if profile is None:
                raise RuntimeError("profile upsert did not return a profile")
            status = "created" if inserted.rowcount == 1 else "exists"

    profile_storage_dir(profile["profile_id"], settings).mkdir(parents=True, exist_ok=True)
    result: dict[str, object] = {
        "profile_id": profile["profile_id"],
        "external_owner_id": profile["external_owner_id"],
        "status": status,
    }
    if include_login_status:
        # Identity and profile come from the same fresh row, not a cross-request cache.
        result["login"] = _login_status_payload(dict(profile))
    return result


def get_profile(profile_id: str, settings: Settings | None = None) -> dict[str, object]:
    settings = settings or get_settings()
    validate_profile_id(profile_id)
    with get_connection(settings) as conn:
        row = conn.execute("SELECT * FROM profiles WHERE profile_id=?", (profile_id,)).fetchone()
    if not row:
        raise ProfileNotFoundError(profile_id)
    return dict(row)


def verify_profile_owner(
    profile_id: str,
    external_owner_id: str,
    settings: Settings | None = None,
) -> dict[str, object]:
    validate_external_owner_id(external_owner_id)
    profile = get_profile(profile_id, settings)
    if profile["external_owner_id"] != external_owner_id:
        raise ProfileOwnershipError("profile does not belong to external_owner_id")
    return profile


def is_profile_logged_in(profile: dict[str, object]) -> bool:
    return profile.get("login_status") == LoginStatus.LOGGED_IN


def lock_profile(profile_id: str, job_id: str, settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    now = utc_now_iso()
    with get_connection(settings) as conn:
        result = conn.execute(
            """
            UPDATE profiles
            SET active_job_id=?, updated_at=?
            WHERE profile_id=? AND (active_job_id IS NULL OR active_job_id='')
              AND NOT EXISTS (SELECT 1 FROM profile_readers WHERE profile_readers.profile_id=profiles.profile_id)
            """,
            (job_id, now, profile_id),
        )
        if result.rowcount != 1:
            raise ProfileLockedError("profile already has an active job")


def release_profile_lock(profile_id: str, job_id: str, settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    now = utc_now_iso()
    with get_connection(settings) as conn:
        conn.execute(
            """
            UPDATE profiles
            SET active_job_id=NULL, updated_at=?
            WHERE profile_id=? AND active_job_id=?
            """,
            (now, profile_id, job_id),
        )


def acquire_profile_reader(profile_id: str, external_owner_id: str, settings: Settings | None = None) -> str:
    """Reads may coexist with an audio job, but never with credential mutation."""
    settings = settings or get_settings()
    validate_profile_id(profile_id)
    validate_external_owner_id(external_owner_id)
    lease_id = f"reader_{uuid.uuid4().hex}"
    with get_connection(settings) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM profiles WHERE profile_id=?", (profile_id,)).fetchone()
        if row is None:
            raise ProfileNotFoundError(profile_id)
        if row["external_owner_id"] != external_owner_id:
            raise ProfileOwnershipError("profile does not belong to external_owner_id")
        active = row["active_job_id"]
        audio_job = conn.execute(
            "SELECT job_id FROM jobs WHERE job_id=? AND profile_id=? AND external_owner_id=?",
            (active, profile_id, external_owner_id),
        ).fetchone() if active else None
        if active and audio_job is None:
            raise ProfileLockedError("login state is being modified; retry shortly")
        readers = conn.execute("SELECT COUNT(*) AS count FROM profile_readers WHERE profile_id=?", (profile_id,)).fetchone()["count"]
        if readers >= 4:
            raise ProfileLockedError("too many concurrent profile reads; retry shortly")
        conn.execute("INSERT INTO profile_readers (lease_id,profile_id,created_at) VALUES (?,?,?)", (lease_id, profile_id, utc_now_iso()))
    return lease_id


def release_profile_reader(profile_id: str, lease_id: str, settings: Settings | None = None) -> None:
    with get_connection(settings) as conn:
        conn.execute("DELETE FROM profile_readers WHERE lease_id=? AND profile_id=?", (lease_id, profile_id))


async def logout_profile(
    profile_id: str,
    external_owner_id: str,
    settings: Settings | None = None,
) -> dict[str, object]:
    """Clear only this kernel-owned browser profile after all users of it are closed."""
    settings = settings or get_settings()
    verify_profile_owner(profile_id, external_owner_id, settings)

    async with _login_runtime_lock():
        starting = _LOGIN_STARTS.get((str(settings.db_path), profile_id))
        runtimes = [runtime for runtime in _LOGIN_RUNTIMES.values()
                    if runtime.profile_id == profile_id and runtime.settings.db_path == settings.db_path]
    tasks = [runtime.task for runtime in runtimes if runtime.task is not None and not runtime.task.done()]
    if starting is not None and not starting.done():
        tasks.append(starting)
    for task in tasks:
        if not task.cancelling():
            task.cancel()
    if tasks:
        _done, pending = await asyncio.wait(tasks, timeout=5)
        if pending:
            raise ProfileLockedError("login session is still closing; retry shortly")
    for runtime in runtimes:
        # Do not delete browser files while an unsuccessfully closed process might rewrite them.
        try:
            async with asyncio.timeout(5):
                await runtime.managed.close()
        except Exception as exc:
            raise ProfileLockedError("browser session could not be closed; retry shortly") from exc

    lock_id = f"logout_{uuid.uuid4().hex[:16]}"
    lock_profile(profile_id, lock_id, settings)
    try:
        _clear_browser_profile(profile_id, settings)
        update_login_metadata(profile_id, logged_in=False, bili_uid=None, nickname=None, settings=settings)
        with get_connection(settings) as conn:
            conn.execute(
                "UPDATE login_sessions SET status=?,message=?,updated_at=? WHERE profile_id=? AND status=?",
                (LoginStatus.LOGGED_OUT, "Login cancelled by user", utc_now_iso(), profile_id, LoginStatus.PENDING),
            )
        return {"profile_id": profile_id, "logged_in": False, "login_status": LoginStatus.LOGGED_OUT}
    finally:
        release_profile_lock(profile_id, lock_id, settings)


def _clear_browser_profile(profile_id: str, settings: Settings) -> None:
    validate_profile_id(profile_id)
    root = settings.profiles_dir.resolve()
    target = profile_storage_dir(profile_id, settings)
    resolved = target.resolve()
    # Never touch the profiles root, symlink destinations, DB, or artifact storage.
    if target.is_symlink() or resolved.parent != root or resolved.name != profile_id:
        raise ValueError("unsafe browser profile path")
    for protected in (settings.db_path.resolve(), settings.artifacts_dir.resolve()):
        if protected == resolved or resolved in protected.parents:
            raise ValueError("browser profile overlaps protected kernel storage")
    if resolved.exists():
        if not resolved.is_dir():
            raise ValueError("browser profile is not a directory")
        shutil.rmtree(resolved)
    resolved.mkdir(parents=False, exist_ok=True)


async def start_login(
    profile_id: str,
    external_owner_id: str,
    settings: Settings | None = None,
) -> dict[str, object]:
    settings = settings or get_settings()
    profile = verify_profile_owner(profile_id, external_owner_id, settings)
    if is_profile_logged_in(profile):
        raise ProfileLockedError("当前账号已经登录；如需换号，请先确认退出。")
    async with _login_runtime_lock():
        for existing in _LOGIN_RUNTIMES.values():
            if (existing.profile_id == profile_id and existing.settings.db_path == settings.db_path
                    and existing.expires_at_monotonic > time.monotonic()
                    and existing.task is not None and not existing.task.done()
                    and existing.qr_path.is_file()):
                return {
                    "login_session_id": existing.login_session_id,
                    "status": "pending",
                    "message": "Existing QR login session reused",
                    "qr_image_url": _qr_image_url(profile_id, existing.login_session_id, external_owner_id),
                    "qr_image_sha256": _sha256_file(existing.qr_path),
                    "expires_in_seconds": max(1, int(existing.expires_at_monotonic - time.monotonic())),
                }
        key = (str(settings.db_path), profile_id)
        task = _LOGIN_STARTS.get(key)
        if task is None or task.done():
            task = asyncio.create_task(_prepare_login(profile_id, external_owner_id, settings))
            _LOGIN_STARTS[key] = task
            def finished(done: asyncio.Task) -> None:
                if _LOGIN_STARTS.get(key) is done:
                    _LOGIN_STARTS.pop(key, None)
                if not done.cancelled():
                    done.exception()  # Observe failure even if the HTTP caller disconnected.
            task.add_done_callback(finished)
    # A disconnected/retried HTTP request does not strand or duplicate a browser.
    # Explicit logout and kernel shutdown still cancel the shared preparation.
    return await asyncio.shield(task)


async def _prepare_login(profile_id: str, external_owner_id: str, settings: Settings) -> dict[str, object]:
    from .browser.context_manager import BrowserContextManager
    from playwright.async_api import Error as BrowserError

    if is_profile_logged_in(verify_profile_owner(profile_id, external_owner_id, settings)):
        raise ProfileLockedError("当前账号已经登录；如需换号，请先确认退出。")
    login_session_id = f"ls_{uuid.uuid4().hex[:16]}"
    lock_id = f"login_{login_session_id}"
    now = utc_now_iso()
    qr_dir = profile_storage_dir(profile_id, settings) / "login_sessions" / login_session_id
    qr_path = qr_dir / "qr.png"
    message = (
        "Scan the Bilibili QR image and confirm on your phone. "
        "The kernel stores login state only inside the profile and returns no cookies."
    )
    lock_profile(profile_id, lock_id, settings)
    managed = None
    runtime = None
    try:
        async with asyncio.timeout(settings.login_preparation_timeout_seconds):
            with get_connection(settings) as conn:
                conn.execute(
                    """
                    INSERT INTO login_sessions (
                        login_session_id, profile_id, status, message, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (login_session_id, profile_id, LoginStatus.PENDING, message, now, now),
                )
                conn.execute(
                    "UPDATE profiles SET login_status=?, updated_at=? WHERE profile_id=?",
                    (LoginStatus.PENDING, now, profile_id),
                )
            managed = await BrowserContextManager(settings).open_request_context(profile_id)
            challenge = await create_qr(managed.context, qr_path, settings)
            # Start the displayed QR's lifetime when it is actually ready, not
            # when Chromium preparation began. Never silently replace this PNG.
            lifetime = min(settings.login_session_timeout_seconds, 180)
            with get_connection(settings) as conn:
                conn.execute("UPDATE login_sessions SET updated_at=? WHERE login_session_id=?", (utc_now_iso(), login_session_id))
            runtime = LoginRuntime(
                login_session_id=login_session_id,
                profile_id=profile_id,
                lock_id=lock_id,
                qr_path=qr_path,
                managed=managed,
                challenge=challenge,
                settings=settings,
                expires_at_monotonic=time.monotonic() + lifetime,
            )
            async with _login_runtime_lock():
                _LOGIN_RUNTIMES[login_session_id] = runtime
            runtime.task = asyncio.create_task(_watch_login_session(runtime))
            qr_sha256 = _sha256_file(qr_path) if qr_path.exists() else None
            return {
                "login_session_id": login_session_id,
                "status": "pending",
                "message": message,
                "qr_image_url": _qr_image_url(profile_id, login_session_id, external_owner_id),
                "qr_image_sha256": qr_sha256,
                "expires_in_seconds": lifetime,
            }
    except BaseException as exc:
        if runtime is not None:
            async with _login_runtime_lock():
                _LOGIN_RUNTIMES.pop(login_session_id, None)
            if runtime.task is not None:
                runtime.task.cancel()
                await asyncio.gather(runtime.task, return_exceptions=True)
        if managed is not None:
            with contextlib.suppress(Exception):
                async with asyncio.timeout(5):
                    await managed.close()
        release_profile_lock(profile_id, lock_id, settings)
        _remove_qr_artifacts(profile_id, login_session_id, settings)
        with contextlib.suppress(Exception):
            update_login_metadata(
                profile_id,
                logged_in=False,
                bili_uid=None,
                nickname=None,
                settings=settings,
            )
        with contextlib.suppress(Exception):
            _update_login_session(
                login_session_id,
                LoginStatus.LOGGED_OUT,
                "QR login start failed; no cookies or QR token internals were returned",
                settings,
            )
        if isinstance(exc, TimeoutError):
            raise LoginFlowError("LOGIN_PREPARATION_TIMEOUT", "二维码准备超时，本次会话已清理，请稍后重试。", 504) from exc
        if isinstance(exc, BrowserError):
            raise LoginFlowError("LOGIN_BROWSER_UNAVAILABLE", "登录组件暂时不可用，请稍后重试。", 503) from exc
        raise


def get_login_qr_image_path(
    *,
    profile_id: str,
    login_session_id: str,
    external_owner_id: str,
    settings: Settings | None = None,
) -> Path:
    settings = settings or get_settings()
    verify_profile_owner(profile_id, external_owner_id, settings)
    validate_login_session_id(login_session_id)
    with get_connection(settings) as conn:
        row = conn.execute(
            "SELECT profile_id, status, updated_at FROM login_sessions WHERE login_session_id=?",
            (login_session_id,),
        ).fetchone()
    if not row or row["profile_id"] != profile_id:
        raise ProfileNotFoundError("login session not found")
    if row["status"] != LoginStatus.PENDING or _login_session_expired(
        row["updated_at"], min(settings.login_session_timeout_seconds, 180)
    ):
        raise FileNotFoundError("login QR is no longer available")
    path = profile_storage_dir(profile_id, settings) / "login_sessions" / login_session_id / "qr.png"
    resolved = path.resolve()
    profile_root = profile_storage_dir(profile_id, settings).resolve()
    if profile_root not in resolved.parents:
        raise PermissionError("login QR path escaped profile storage")
    if not resolved.exists():
        raise FileNotFoundError("login QR image not ready")
    return resolved


def get_login_status(
    profile_id: str,
    settings: Settings | None = None,
    *,
    external_owner_id: str | None = None,
) -> dict[str, object]:
    profile = (get_profile(profile_id, settings) if external_owner_id is None
               else verify_profile_owner(profile_id, external_owner_id, settings))
    return _login_status_payload(profile)


def _login_status_payload(profile: dict[str, object]) -> dict[str, object]:
    return {
        "profile_id": profile["profile_id"],
        "logged_in": profile.get("login_status") == LoginStatus.LOGGED_IN,
        "login_status": str(profile.get("login_status") or LoginStatus.UNKNOWN),
        "bili_uid": profile.get("bili_uid"),
        "nickname": profile.get("nickname"),
        "last_verified_at": profile.get("last_verified_at"),
    }


def update_login_metadata(
    profile_id: str,
    *,
    logged_in: bool,
    bili_uid: str | None,
    nickname: str | None,
    settings: Settings | None = None,
) -> dict[str, object]:
    settings = settings or get_settings()
    validate_profile_id(profile_id)
    now = utc_now_iso()
    status = LoginStatus.LOGGED_IN if logged_in else LoginStatus.LOGGED_OUT
    with get_connection(settings) as conn:
        conn.execute(
            """
            UPDATE profiles
            SET login_status=?, bili_uid=?, nickname=?, last_verified_at=?, updated_at=?
            WHERE profile_id=?
            """,
            (status, bili_uid, nickname, now, now, profile_id),
        )
    return {
        "profile_id": profile_id,
        "logged_in": logged_in,
        "bili_uid": bili_uid,
        "nickname": nickname,
        "last_verified_at": now,
    }


def _login_runtime_lock() -> asyncio.Lock:
    global _LOGIN_RUNTIME_LOCK
    if _LOGIN_RUNTIME_LOCK is None:
        _LOGIN_RUNTIME_LOCK = asyncio.Lock()
    return _LOGIN_RUNTIME_LOCK


async def shutdown_login_runtimes() -> None:
    """Cancel pending login watchers so their finally blocks close browser profiles."""
    async with _login_runtime_lock():
        tasks = [
            runtime.task
            for runtime in _LOGIN_RUNTIMES.values()
            if runtime.task is not None and not runtime.task.done()
        ]
        tasks.extend(task for task in _LOGIN_STARTS.values() if not task.done())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


def recover_stale_login_sessions(settings: Settings | None = None) -> dict[str, int]:
    """Expire pending QR sessions left behind by a previous kernel process."""
    settings = settings or get_settings()
    now = utc_now_iso()
    with get_connection(settings) as conn:
        rows = conn.execute(
            "SELECT login_session_id, profile_id, created_at FROM login_sessions WHERE status=?",
            (LoginStatus.PENDING,),
        ).fetchall()
        # No watcher can be restored across a process restart.  Treat all
        # persisted pending sessions as stale so their QR cannot linger.
        stale = [
            (str(row["login_session_id"]), str(row["profile_id"]))
            for row in rows
        ]
        for login_session_id, profile_id in stale:
            conn.execute(
                "UPDATE login_sessions SET status=?, message=?, updated_at=? WHERE login_session_id=?",
                (
                    "expired",
                    "QR login session expired; start a new login session for a fresh QR image",
                    now,
                    login_session_id,
                ),
            )
            conn.execute(
                "UPDATE profiles SET login_status=?, updated_at=? WHERE profile_id=? AND login_status=?",
                (LoginStatus.UNKNOWN, now, profile_id, LoginStatus.PENDING),
            )
            conn.execute(
                "UPDATE profiles SET active_job_id=NULL, updated_at=? WHERE profile_id=? AND active_job_id=?",
                (now, profile_id, f"login_{login_session_id}"),
            )
    for login_session_id, profile_id in stale:
        _remove_qr_artifacts(profile_id, login_session_id, settings)
    return {"login_sessions_expired": len(stale)}


async def _watch_login_session(runtime: LoginRuntime) -> None:
    from playwright.async_api import Error as BrowserError

    failures = 0
    confirmed = False
    try:
        while time.monotonic() < runtime.expires_at_monotonic:
            try:
                async with asyncio.timeout(max(0.01, min(15, runtime.expires_at_monotonic - time.monotonic()))):
                    if not confirmed:
                        state = await poll_qr(runtime.managed.context, runtime.challenge, runtime.settings)
                        if state == "expired":
                            break
                        confirmed = state == "confirmed"
                    identity = await _verify_bilibili_identity(runtime.managed.context, runtime.settings) if confirmed else {"logged_in": False}
                    if confirmed and not identity["logged_in"]:
                        raise LoginFlowError("LOGIN_IDENTITY_PENDING", "正在确认 B 站登录身份，请稍候。")
                failures = 0
            except (LoginFlowError, TimeoutError, BrowserError) as exc:
                failures += 1
                if (isinstance(exc, LoginFlowError) and not exc.retryable) or failures >= 4:
                    raise
                await asyncio.sleep(min(runtime.settings.login_poll_interval_seconds * (2 ** (failures - 1)),
                                        max(0, runtime.expires_at_monotonic - time.monotonic())))
                continue
            if bool(identity["logged_in"]):
                update_login_metadata(
                    runtime.profile_id,
                    logged_in=True,
                    bili_uid=str(identity["bili_uid"]) if identity["bili_uid"] else None,
                    nickname=str(identity["nickname"]) if identity["nickname"] else None,
                    settings=runtime.settings,
                )
                _update_login_session(
                    runtime.login_session_id,
                    LoginStatus.LOGGED_IN,
                    "login verified; browser session state remains inside kernel profile storage",
                    runtime.settings,
                )
                return
            await asyncio.sleep(min(runtime.settings.login_poll_interval_seconds,
                                    max(0, runtime.expires_at_monotonic - time.monotonic())))

        update_login_metadata(
            runtime.profile_id,
            logged_in=False,
            bili_uid=None,
            nickname=None,
            settings=runtime.settings,
        )
        _update_login_session(
            runtime.login_session_id,
            "expired",
            "QR login session expired; start a new login session for a fresh QR image",
            runtime.settings,
        )
    except Exception:
        # Network/browser failures must not leave an apparently active QR or a
        # permanently pending profile behind.  The raw exception is not
        # persisted because it may contain request details or headers.
        update_login_metadata(
            runtime.profile_id,
            logged_in=False,
            bili_uid=None,
            nickname=None,
            settings=runtime.settings,
        )
        _update_login_session(
            runtime.login_session_id,
            LoginStatus.LOGGED_OUT,
            "QR login verification failed; start a new login session",
            runtime.settings,
        )
    finally:
        _expire_pending_login_runtime(runtime)
        _remove_qr_artifacts(runtime.profile_id, runtime.login_session_id, runtime.settings)
        with contextlib.suppress(Exception):
            await runtime.managed.close()
        release_profile_lock(runtime.profile_id, runtime.lock_id, runtime.settings)
        async with _login_runtime_lock():
            _LOGIN_RUNTIMES.pop(runtime.login_session_id, None)


def _update_login_session(
    login_session_id: str,
    status: str,
    message: str,
    settings: Settings,
) -> None:
    now = utc_now_iso()
    with get_connection(settings) as conn:
        conn.execute(
            """
            UPDATE login_sessions
            SET status=?, message=?, updated_at=?
            WHERE login_session_id=?
            """,
            (status, sanitize_text(message), now, login_session_id),
        )


def _login_session_expired(created_at: object, timeout_seconds: int) -> bool:
    try:
        created = datetime.fromisoformat(str(created_at))
    except (TypeError, ValueError):
        return True
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    return datetime.now(UTC) >= created.astimezone(UTC) + timedelta(seconds=max(1, timeout_seconds))


def _remove_qr_artifacts(profile_id: str, login_session_id: str, settings: Settings) -> None:
    """Delete only the QR session directory inside the profile-owned root."""
    try:
        validate_profile_id(profile_id)
        validate_login_session_id(login_session_id)
        profile_root = profile_storage_dir(profile_id, settings).resolve()
        qr_dir = (profile_root / "login_sessions" / login_session_id).resolve()
        if profile_root not in qr_dir.parents:
            return
        shutil.rmtree(qr_dir, ignore_errors=True)
    except (OSError, ValueError):
        return


def _expire_pending_login_runtime(runtime: LoginRuntime) -> None:
    """Make cancellation/abnormal watcher exits terminal before cleanup."""
    try:
        with get_connection(runtime.settings) as conn:
            row = conn.execute(
                "SELECT status FROM login_sessions WHERE login_session_id=?",
                (runtime.login_session_id,),
            ).fetchone()
        if row and row["status"] == LoginStatus.PENDING:
            update_login_metadata(
                runtime.profile_id,
                logged_in=False,
                bili_uid=None,
                nickname=None,
                settings=runtime.settings,
            )
            _update_login_session(
                runtime.login_session_id,
                "expired",
                "QR login session ended; start a new login session",
                runtime.settings,
            )
    except Exception:
        return


def _qr_image_url(profile_id: str, login_session_id: str, external_owner_id: str) -> str:
    return (
        f"/v1/profiles/{quote(profile_id)}/login/{quote(login_session_id)}/qr.png"
        f"?external_owner_id={quote(external_owner_id, safe='')}"
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_cookie_import(format_name: str, payload: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if format_name == "cookie_header":
        if not isinstance(payload, str):
            raise CookieImportError("cookie_header import requires string cookie content")
        _ensure_text_size(payload)
        return _parse_cookie_header(payload), []
    if format_name == "netscape":
        if not isinstance(payload, str):
            raise CookieImportError("netscape import requires string cookie content")
        _ensure_text_size(payload)
        return _parse_netscape_cookie_file(payload), []
    if format_name == "json":
        parsed = _loads_if_json_string(payload)
        return _parse_json_cookies(parsed), []
    if format_name == "playwright_storage_state":
        parsed = _loads_if_json_string(payload)
        if not isinstance(parsed, dict):
            raise CookieImportError("playwright_storage_state import requires a JSON object")
        cookies = _parse_json_cookies(parsed.get("cookies") or [])
        origins = _parse_storage_state_origins(parsed.get("origins") or [])
        return cookies, origins
    raise CookieImportError("unsupported cookie import format")


async def import_cookies_to_profile(
    *,
    profile_id: str,
    external_owner_id: str,
    format_name: str,
    cookies_payload: Any,
    settings: Settings | None = None,
) -> CookieImportResult:
    from .browser.context_manager import BrowserContextManager

    settings = settings or get_settings()
    validate_profile_id(profile_id)
    validate_external_owner_id(external_owner_id)

    verify_profile_owner(profile_id, external_owner_id, settings)
    lock_id = f"cookie_import_{uuid.uuid4().hex[:12]}"
    lock_profile(profile_id, lock_id, settings)
    managed = None
    try:
        cookies, origins = parse_cookie_import(format_name, cookies_payload)
        if not cookies and not origins:
            raise CookieImportError("import payload did not contain cookies or storage origins")

        managed = await BrowserContextManager(settings).open_context(profile_id)
        if cookies:
            await managed.context.add_cookies(cookies)
        if origins:
            await _import_local_storage_origins(managed.context, origins, settings)
        identity = await _verify_bilibili_identity(managed.context, settings)
        stored = update_login_metadata(
            profile_id,
            logged_in=identity["logged_in"],
            bili_uid=identity["bili_uid"],
            nickname=identity["nickname"],
            settings=settings,
        )
        return CookieImportResult(
            profile_id=profile_id,
            status="imported",
            logged_in=bool(stored["logged_in"]),
            bili_uid=stored["bili_uid"],
            nickname=stored["nickname"],
            last_verified_at=stored["last_verified_at"],
            message="cookies imported into kernel profile; raw payload discarded",
        )
    except (ProfileNotFoundError, ProfileOwnershipError, ProfileLockedError):
        raise
    except CookieImportError:
        raise
    except Exception as exc:
        raise CookieImportError(
            f"cookie import failed inside browser context: {sanitize_text(type(exc).__name__)}"
        ) from exc
    finally:
        try:
            if managed is not None:
                await managed.close()
        finally:
            release_profile_lock(profile_id, lock_id, settings)


def _loads_if_json_string(payload: Any) -> Any:
    if isinstance(payload, str):
        _ensure_text_size(payload)
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise CookieImportError("JSON cookie import payload is invalid JSON") from exc
        _validate_import_structure(parsed)
        return parsed
    _validate_import_structure(payload)
    return payload


def _ensure_text_size(value: str) -> None:
    if len(value.encode("utf-8", errors="ignore")) > MAX_COOKIE_IMPORT_PAYLOAD_BYTES:
        raise CookieImportError("cookie import payload exceeds the maximum size")


def _validate_import_structure(value: Any, *, depth: int = 0, budget: list[int] | None = None) -> None:
    if budget is None:
        budget = [0]
    if depth > 8:
        raise CookieImportError("cookie import payload nesting is too deep")
    if isinstance(value, str):
        size = len(value.encode("utf-8", errors="ignore"))
        budget[0] += size
        if budget[0] > MAX_COOKIE_IMPORT_PAYLOAD_BYTES:
            raise CookieImportError("cookie import payload exceeds the maximum size")
    elif isinstance(value, list):
        if len(value) > max(MAX_COOKIE_ENTRIES, MAX_STORAGE_ORIGINS):
            raise CookieImportError("cookie import contains too many entries")
        for item in value:
            _validate_import_structure(item, depth=depth + 1, budget=budget)
    elif isinstance(value, dict):
        if len(value) > MAX_COOKIE_ENTRIES:
            raise CookieImportError("cookie import object contains too many fields")
        for key, item in value.items():
            _validate_import_structure(str(key), depth=depth + 1, budget=budget)
            _validate_import_structure(item, depth=depth + 1, budget=budget)
    elif value is not None and not isinstance(value, (bool, int, float)):
        raise CookieImportError("cookie import payload contains an unsupported value")


def _parse_netscape_cookie_file(text: str) -> list[dict[str, Any]]:
    cookies: list[dict[str, Any]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or (line.startswith("#") and not line.startswith("#HttpOnly_")):
            continue
        http_only = line.startswith("#HttpOnly_")
        if http_only:
            line = line.removeprefix("#HttpOnly_")
        parts = line.split("\t")
        if len(parts) != 7:
            raise CookieImportError("invalid netscape cookie line")
        domain, _include_subdomains, path, secure, expires, name, value = parts
        cookies.append(
            _normalize_cookie(
                {
                    "domain": domain,
                    "path": path or "/",
                    "secure": secure.upper() == "TRUE",
                    "expires": _parse_expires(expires),
                    "name": name,
                    "value": value,
                    "httpOnly": http_only,
                }
            )
        )
        if len(cookies) > MAX_COOKIE_ENTRIES:
            raise CookieImportError("cookie import contains too many cookies")
    return cookies


def _parse_cookie_header(text: str) -> list[dict[str, Any]]:
    cookies: list[dict[str, Any]] = []
    header = text.strip()
    if header.lower().startswith("cookie:"):
        header = header.split(":", 1)[1].strip()
    for part in header.split(";"):
        item = part.strip()
        if not item:
            continue
        if "=" not in item:
            raise CookieImportError("invalid cookie_header entry")
        name, value = item.split("=", 1)
        cookies.append(
            _normalize_cookie(
                {
                    "name": name.strip(),
                    "value": value.strip(),
                    "domain": ".bilibili.com",
                    "path": "/",
                    "secure": True,
                }
            )
        )
        if len(cookies) > MAX_COOKIE_ENTRIES:
            raise CookieImportError("cookie import contains too many cookies")
    if not cookies:
        raise CookieImportError("cookie_header import did not contain any cookies")
    return cookies


def _parse_json_cookies(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict) and isinstance(payload.get("cookies"), list):
        payload = payload["cookies"]
    if isinstance(payload, dict):
        if "name" in payload and "value" in payload:
            payload = [payload]
        else:
            payload = [
                {
                    "name": str(name),
                    "value": str(value),
                    "domain": ".bilibili.com",
                    "path": "/",
                    "secure": True,
                }
                for name, value in payload.items()
            ]
    if not isinstance(payload, list):
        raise CookieImportError("json cookie import requires an object or list")

    cookies = []
    if len(payload) > MAX_COOKIE_ENTRIES:
        raise CookieImportError("cookie import contains too many cookies")
    for item in payload:
        if not isinstance(item, dict):
            raise CookieImportError("cookie entries must be JSON objects")
        cookies.append(_normalize_cookie(item))
    return cookies


def _normalize_cookie(item: dict[str, Any]) -> dict[str, Any]:
    name = str(item.get("name") or "")
    value = str(item.get("value") or "")
    if not name:
        raise CookieImportError("cookie entry missing name")
    if value == "":
        raise CookieImportError("cookie entry missing value")
    if len(name) > MAX_COOKIE_NAME_LENGTH:
        raise CookieImportError("cookie name is too long")
    if len(value.encode("utf-8", errors="ignore")) > MAX_COOKIE_VALUE_LENGTH:
        raise CookieImportError("cookie value is too long")

    path = str(item.get("path") or "/")
    if not path.startswith("/"):
        raise CookieImportError("cookie path must start with /")
    if len(path) > MAX_COOKIE_PATH_LENGTH:
        raise CookieImportError("cookie path is too long")

    cookie: dict[str, Any] = {
        "name": name,
        "value": value,
        "path": path,
        "secure": bool(item.get("secure", True)),
        "httpOnly": bool(item.get("httpOnly") or item.get("http_only") or False),
    }
    same_site = item.get("sameSite") or item.get("same_site")
    if same_site in {"Strict", "Lax", "None"}:
        cookie["sameSite"] = same_site

    url = item.get("url")
    domain = item.get("domain") or item.get("host")
    if url:
        parsed = urlparse(str(url))
        if parsed.scheme not in {"http", "https"} or not is_bilibili_host(parsed.hostname):
            raise CookieImportError("cookie URL must use a Bilibili host")
        cookie["url"] = f"{parsed.scheme}://{parsed.hostname}"
    elif domain:
        normalized_domain = str(domain).strip().lower().lstrip(".")
        if not is_bilibili_host(normalized_domain):
            raise CookieImportError("cookie domain must be bilibili.com or a subdomain")
        cookie["domain"] = f".{normalized_domain}" if str(domain).strip().startswith(".") else normalized_domain
    else:
        cookie["domain"] = ".bilibili.com"

    expires = item.get("expires", item.get("expirationDate", item.get("expiration")))
    parsed_expires = _parse_expires(expires)
    if parsed_expires is not None:
        cookie["expires"] = parsed_expires
    return cookie


def _parse_expires(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        expires = int(float(value))
    except (TypeError, ValueError):
        return None
    return expires if expires > 0 else None


def _parse_storage_state_origins(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        raise CookieImportError("storage_state origins must be a list")
    if len(payload) > MAX_STORAGE_ORIGINS:
        raise CookieImportError("storage_state contains too many origins")
    origins: list[dict[str, Any]] = []
    total_storage_bytes = 0
    for origin in payload:
        if not isinstance(origin, dict):
            raise CookieImportError("storage_state origin entries must be objects")
        origin_url = str(origin.get("origin") or "")
        parsed = urlparse(origin_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            continue
        if not is_bilibili_host(parsed.hostname):
            continue
        local_storage = origin.get("localStorage") or []
        if not isinstance(local_storage, list):
            raise CookieImportError("storage_state localStorage must be a list")
        if len(local_storage) > MAX_LOCAL_STORAGE_ENTRIES:
            raise CookieImportError("storage_state origin contains too many localStorage entries")
        normalized_storage: list[dict[str, str]] = []
        for item in local_storage:
            if not isinstance(item, dict):
                raise CookieImportError("storage_state localStorage entries must be objects")
            key = str(item.get("name") or item.get("key") or "")
            value = str(item.get("value") or "")
            if not key:
                continue
            if len(key) > MAX_LOCAL_STORAGE_KEY_LENGTH:
                raise CookieImportError("storage_state localStorage key is too long")
            if len(value.encode("utf-8", errors="ignore")) > MAX_LOCAL_STORAGE_VALUE_LENGTH:
                raise CookieImportError("storage_state localStorage value is too long")
            total_storage_bytes += len(key.encode("utf-8")) + len(value.encode("utf-8"))
            if total_storage_bytes > MAX_LOCAL_STORAGE_TOTAL_BYTES:
                raise CookieImportError("storage_state localStorage payload is too large")
            normalized_storage.append({"name": key, "value": value})
        origins.append({"origin": f"{parsed.scheme}://{parsed.hostname}", "localStorage": normalized_storage})
    return origins


async def _import_local_storage_origins(
    context: Any,
    origins: list[dict[str, Any]],
    settings: Settings,
) -> None:
    page = await context.new_page()
    try:
        for origin in origins:
            await page.goto(
                str(origin["origin"]),
                wait_until="domcontentloaded",
                timeout=int(settings.request_timeout_seconds * 1000),
            )
            for item in origin["localStorage"]:
                if not isinstance(item, dict):
                    continue
                key = str(item.get("name") or "")
                value = str(item.get("value") or "")
                if key:
                    await page.evaluate(
                        "([key, value]) => window.localStorage.setItem(key, value)",
                        [key, value],
                    )
    finally:
        await page.close()


async def _verify_bilibili_identity(context: Any, settings: Settings) -> dict[str, str | bool | None]:
    response = await context.request.get(
        "https://api.bilibili.com/x/web-interface/nav",
        headers={
            "user-agent": settings.bilibili_user_agent,
            "referer": "https://www.bilibili.com/",
        },
        timeout=int(settings.request_timeout_seconds * 1000),
    )
    async with managed_response(response):
        if response.status != 200:
            return {"logged_in": False, "bili_uid": None, "nickname": None}
        payload = await response.json()
    data = payload.get("data") or {}
    logged_in = bool(data.get("isLogin"))
    return {
        "logged_in": logged_in,
        "bili_uid": str(data.get("mid")) if logged_in and data.get("mid") is not None else None,
        "nickname": str(data.get("uname")) if logged_in and data.get("uname") else None,
    }
