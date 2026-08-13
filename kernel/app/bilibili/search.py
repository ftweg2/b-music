from __future__ import annotations

import time
import uuid
from typing import Any

from app.browser.context_manager import BrowserContextManager
from app.config import Settings, get_settings
from app.models import LoginStatus
from app.profile_manager import (
    ProfileLockedError,
    ProfileNotFoundError,
    ProfileOwnershipError,
    get_profile,
    lock_profile,
    release_profile_lock,
    verify_profile_owner,
)
from app.bilibili.bvid import parse_bvid
from app.security import sanitize_text, sanitize_url, validate_external_owner_id, validate_profile_id


_SEARCH_BUCKETS: dict[str, list[float]] = {}


class KernelSearchError(RuntimeError):
    pass


async def search_videos_with_profile(
    *,
    external_owner_id: str,
    profile_id: str,
    keyword: str,
    limit: int,
    page: int = 1,
    settings: Settings | None = None,
) -> dict[str, object]:
    settings = settings or get_settings()
    validate_external_owner_id(external_owner_id)
    validate_profile_id(profile_id)
    verify_profile_owner(profile_id, external_owner_id, settings)
    _assert_profile_search_rate(profile_id)

    safe_keyword = sanitize_text(keyword, 200).strip()
    if not safe_keyword:
        raise KernelSearchError("keyword is required")

    lock_id = f"search_{uuid.uuid4().hex[:16]}"
    lock_profile(profile_id, lock_id, settings)
    managed = None
    try:
        profile = get_profile(profile_id, settings)
        managed = await BrowserContextManager(settings).open_context(profile_id)
        url = _search_url(safe_keyword, min(max(limit, 1), 50), min(max(page, 1), 10))
        response = await managed.context.request.get(
            url,
            timeout=int(settings.request_timeout_seconds * 1000),
            headers={
                "accept": "application/json,text/plain,*/*",
                "referer": "https://www.bilibili.com/",
            },
        )
        if response.status >= 400:
            raise KernelSearchError(f"Bilibili search HTTP {response.status}")
        payload = await response.json()
        results = payload.get("data", {}).get("result", [])
        if not isinstance(results, list):
            raise KernelSearchError(f"Bilibili search returned no video results: {sanitize_text(payload.get('message'))}")
        logged_in = profile.get("login_status") == LoginStatus.LOGGED_IN
        return {
            "provider": "kernel_bilibili",
            "profile_id": profile_id,
            "logged_in": logged_in,
            "results": [_normalize_result(item) for item in results if isinstance(item, dict)][:limit],
        }
    finally:
        try:
            if managed is not None:
                await managed.close()
        finally:
            release_profile_lock(profile_id, lock_id, settings)


def _search_url(keyword: str, limit: int, page: int = 1) -> str:
    from urllib.parse import urlencode

    query = urlencode(
        {
            "search_type": "video",
            "keyword": keyword,
            "page": str(page),
            "page_size": str(limit),
        }
    )
    return f"https://api.bilibili.com/x/web-interface/search/type?{query}"


def _assert_profile_search_rate(profile_id: str) -> None:
    now = time.monotonic()
    window_seconds = 60.0
    limit = 10
    timestamps = [stamp for stamp in _SEARCH_BUCKETS.get(profile_id, []) if now - stamp < window_seconds]
    if len(timestamps) >= limit:
        raise KernelSearchError("search rate limit exceeded; wait before searching again")
    timestamps.append(now)
    _SEARCH_BUCKETS[profile_id] = timestamps
    if len(_SEARCH_BUCKETS) > 1024:
        stale_profiles = [
            key
            for key, values in _SEARCH_BUCKETS.items()
            if key != profile_id and not any(now - stamp < window_seconds for stamp in values)
        ]
        for key in stale_profiles:
            _SEARCH_BUCKETS.pop(key, None)


def _normalize_result(item: dict[str, Any]) -> dict[str, object]:
    bvid = parse_bvid(str(item.get("bvid") or item.get("arcurl") or "")) or ""
    source_url = f"https://www.bilibili.com/video/{bvid}" if bvid else sanitize_url(str(item.get("arcurl") or "")) or ""
    return {
        "bvid": bvid,
        "aid": str(item.get("aid")) if item.get("aid") else None,
        "title": _strip_html(sanitize_text(item.get("title") or bvid, 500)),
        "description": sanitize_text(item.get("description") or "", 1000) or None,
        "creator_mid": _sanitize_mid(item.get("mid")),
        "creator_name": sanitize_text(item.get("author") or "", 200) or None,
        "cover_url": _normalize_cover_url(item.get("pic")),
        "duration_seconds": _parse_duration(item.get("duration")),
        "pub_time": _parse_pub_time(item.get("pubdate")),
        "source_url": source_url,
        "category": sanitize_text(item.get("typename") or "", 100) or None,
        "tags": [],
    }


def _normalize_cover_url(value: object) -> str | None:
    text = str(value or "").strip()
    if text.startswith("//"):
        text = f"https:{text}"
    return sanitize_url(text) if text else None


def _sanitize_mid(value: object) -> str | None:
    import re

    text = str(value or "").strip()
    return text if re.fullmatch(r"\d{1,24}", text) else None


def _strip_html(value: str) -> str:
    import re

    return re.sub(r"<[^>]+>", "", value).strip()


def _parse_duration(value: object) -> int | None:
    if isinstance(value, (int, float)):
        return max(0, int(value))
    text = str(value or "").strip()
    if not text:
        return None
    parts = [int(part) for part in text.split(":") if part.isdigit()]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return None


def _parse_pub_time(value: object) -> str | None:
    from datetime import datetime, timezone

    try:
        timestamp = int(value)
    except (TypeError, ValueError):
        return None
    if timestamp <= 0:
        return None
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
