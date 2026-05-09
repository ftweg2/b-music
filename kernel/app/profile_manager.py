from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from .config import Settings, get_settings
from .db import get_connection
from .models import LoginStatus, utc_now_iso
from .security import (
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
    page: Any
    settings: Settings
    expires_at_monotonic: float
    task: asyncio.Task[None] | None = None


_LOGIN_RUNTIMES: dict[str, LoginRuntime] = {}
_LOGIN_RUNTIME_LOCK: asyncio.Lock | None = None


def _new_profile_id() -> str:
    return f"p_{uuid.uuid4().hex[:16]}"


def profile_storage_dir(profile_id: str, settings: Settings | None = None):
    settings = settings or get_settings()
    validate_profile_id(profile_id)
    return settings.profiles_dir / profile_id


def create_or_get_profile(external_owner_id: str, settings: Settings | None = None) -> dict[str, str]:
    settings = settings or get_settings()
    validate_external_owner_id(external_owner_id)
    now = utc_now_iso()
    with get_connection(settings) as conn:
        existing = conn.execute(
            "SELECT profile_id, external_owner_id FROM profiles WHERE external_owner_id=?",
            (external_owner_id,),
        ).fetchone()
        if existing:
            profile_storage_dir(existing["profile_id"], settings).mkdir(parents=True, exist_ok=True)
            return {
                "profile_id": existing["profile_id"],
                "external_owner_id": existing["external_owner_id"],
                "status": "exists",
            }

        profile_id = _new_profile_id()
        conn.execute(
            """
            INSERT INTO profiles (
                profile_id, external_owner_id, login_status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (profile_id, external_owner_id, LoginStatus.UNKNOWN, now, now),
        )
        profile_storage_dir(profile_id, settings).mkdir(parents=True, exist_ok=True)
        return {"profile_id": profile_id, "external_owner_id": external_owner_id, "status": "created"}


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


async def start_login(
    profile_id: str,
    external_owner_id: str,
    settings: Settings | None = None,
) -> dict[str, object]:
    from .browser.context_manager import BrowserContextManager

    settings = settings or get_settings()
    verify_profile_owner(profile_id, external_owner_id, settings)
    login_session_id = f"ls_{uuid.uuid4().hex[:16]}"
    lock_id = f"login_{login_session_id}"
    now = utc_now_iso()
    qr_dir = profile_storage_dir(profile_id, settings) / "login_sessions" / login_session_id
    qr_dir.mkdir(parents=True, exist_ok=True)
    qr_path = qr_dir / "qr.png"
    message = (
        "Scan the QR image from the kernel profile login page. "
        "The kernel stores login state only inside the profile and returns no cookies."
    )
    lock_profile(profile_id, lock_id, settings)
    managed = None
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
    try:
        managed = await BrowserContextManager(settings).open_context(profile_id)
        page = await managed.context.new_page()
        await page.set_viewport_size({"width": 520, "height": 720})
        await page.goto(
            settings.bilibili_login_url,
            wait_until="domcontentloaded",
            timeout=int(settings.request_timeout_seconds * 1000),
        )
        await _capture_login_qr(page, qr_path)
        runtime = LoginRuntime(
            login_session_id=login_session_id,
            profile_id=profile_id,
            lock_id=lock_id,
            qr_path=qr_path,
            managed=managed,
            page=page,
            settings=settings,
            expires_at_monotonic=time.monotonic() + settings.login_session_timeout_seconds,
        )
        runtime.task = asyncio.create_task(_watch_login_session(runtime))
        async with _login_runtime_lock():
            _LOGIN_RUNTIMES[login_session_id] = runtime
        qr_sha256 = _sha256_file(qr_path) if qr_path.exists() else None
        return {
            "login_session_id": login_session_id,
            "status": "pending",
            "message": message,
            "qr_image_url": _qr_image_url(profile_id, login_session_id, external_owner_id),
            "qr_image_sha256": qr_sha256,
            "expires_in_seconds": settings.login_session_timeout_seconds,
        }
    except Exception:
        if managed is not None:
            await managed.close()
        release_profile_lock(profile_id, lock_id, settings)
        _update_login_session(
            login_session_id,
            LoginStatus.LOGGED_OUT,
            "QR login start failed; no cookies or QR token internals were returned",
            settings,
        )
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
            "SELECT profile_id FROM login_sessions WHERE login_session_id=?",
            (login_session_id,),
        ).fetchone()
    if not row or row["profile_id"] != profile_id:
        raise ProfileNotFoundError("login session not found")
    path = profile_storage_dir(profile_id, settings) / "login_sessions" / login_session_id / "qr.png"
    resolved = path.resolve()
    profile_root = profile_storage_dir(profile_id, settings).resolve()
    if profile_root not in resolved.parents:
        raise PermissionError("login QR path escaped profile storage")
    if not resolved.exists():
        raise FileNotFoundError("login QR image not ready")
    return resolved


def get_login_status(profile_id: str, settings: Settings | None = None) -> dict[str, object]:
    profile = get_profile(profile_id, settings)
    return {
        "profile_id": profile["profile_id"],
        "logged_in": profile.get("login_status") == LoginStatus.LOGGED_IN,
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


async def _watch_login_session(runtime: LoginRuntime) -> None:
    refresh_at = time.monotonic() + runtime.settings.login_qr_refresh_seconds
    try:
        while time.monotonic() < runtime.expires_at_monotonic:
            identity = await _verify_bilibili_identity(runtime.managed.context, runtime.settings)
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
            now = time.monotonic()
            if now >= refresh_at:
                with contextlib.suppress(Exception):
                    await runtime.page.reload(
                        wait_until="domcontentloaded",
                        timeout=int(runtime.settings.request_timeout_seconds * 1000),
                    )
                    await _capture_login_qr(runtime.page, runtime.qr_path)
                refresh_at = now + runtime.settings.login_qr_refresh_seconds
            await asyncio.sleep(runtime.settings.login_poll_interval_seconds)

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
    finally:
        with contextlib.suppress(Exception):
            await runtime.managed.close()
        release_profile_lock(runtime.profile_id, runtime.lock_id, runtime.settings)
        async with _login_runtime_lock():
            _LOGIN_RUNTIMES.pop(runtime.login_session_id, None)


async def _capture_login_qr(page: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    selectors = [
        ".login-scan-box",
        ".qrcode-box",
        ".qr-code",
        "[class*='qrcode']",
        "[class*='qr-code']",
        "canvas",
    ]
    for selector in selectors:
        with contextlib.suppress(Exception):
            locator = page.locator(selector).first
            await locator.wait_for(state="visible", timeout=3000)
            await locator.screenshot(path=str(path))
            if path.exists() and path.stat().st_size > 0:
                return
    await page.screenshot(path=str(path), full_page=True)


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
        return _parse_cookie_header(payload), []
    if format_name == "netscape":
        if not isinstance(payload, str):
            raise CookieImportError("netscape import requires string cookie content")
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
        if managed is not None:
            await managed.close()
        release_profile_lock(profile_id, lock_id, settings)


def _loads_if_json_string(payload: Any) -> Any:
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except json.JSONDecodeError as exc:
            raise CookieImportError("JSON cookie import payload is invalid JSON") from exc
    return payload


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

    cookie: dict[str, Any] = {
        "name": name,
        "value": value,
        "path": str(item.get("path") or "/"),
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
        if parsed.scheme and parsed.netloc:
            cookie["url"] = f"{parsed.scheme}://{parsed.netloc}"
    elif domain:
        cookie["domain"] = str(domain)
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
    origins: list[dict[str, Any]] = []
    for origin in payload:
        if not isinstance(origin, dict):
            raise CookieImportError("storage_state origin entries must be objects")
        origin_url = str(origin.get("origin") or "")
        parsed = urlparse(origin_url)
        if not parsed.scheme or not parsed.netloc:
            continue
        if not parsed.netloc.endswith("bilibili.com"):
            continue
        local_storage = origin.get("localStorage") or []
        if not isinstance(local_storage, list):
            raise CookieImportError("storage_state localStorage must be a list")
        origins.append({"origin": f"{parsed.scheme}://{parsed.netloc}", "localStorage": local_storage})
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
