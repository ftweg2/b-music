from __future__ import annotations

import asyncio
import math
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
    acquire_profile_reader,
    release_profile_reader,
    verify_profile_owner,
)
from app.bilibili.bvid import parse_bvid
from app.security import sanitize_text, sanitize_url, validate_external_owner_id, validate_profile_id


_SEARCH_BUCKETS: dict[str, list[float]] = {}


class KernelSearchError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502, retry_after: int | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after


async def search_videos_with_profile(
    *,
    external_owner_id: str,
    profile_id: str,
    keyword: str,
    limit: int,
    page: int = 1,
    settings: Settings | None = None,
    timeout_seconds: float = 8.0,
) -> dict[str, object]:
    settings = settings or get_settings()
    validate_external_owner_id(external_owner_id)
    validate_profile_id(profile_id)
    verify_profile_owner(profile_id, external_owner_id, settings)
    _assert_profile_search_rate(profile_id)

    safe_keyword = sanitize_text(keyword, 200).strip()
    if not safe_keyword:
        raise KernelSearchError("keyword is required", 400)

    lease_id = acquire_profile_reader(profile_id, external_owner_id, settings)
    managed = None
    try:
        async with asyncio.timeout(min(30.0, max(1.0, timeout_seconds))):
            profile = get_profile(profile_id, settings)
            managed = await BrowserContextManager(settings).open_context(profile_id)
            safe_limit = min(max(limit, 1), 20)
            safe_page = min(max(page, 1), 10)
            response = await managed.context.request.get(
                _search_url(safe_keyword, safe_limit, safe_page),
                timeout=int(min(settings.request_timeout_seconds, timeout_seconds) * 1000),
                headers={"accept": "application/json,text/plain,*/*", "referer": "https://www.bilibili.com/"},
            )
            if response.status >= 400:
                raise KernelSearchError(f"Bilibili search HTTP {response.status}")
            payload = await response.json()
            results, has_next_page = parse_search_payload(payload, safe_page, safe_limit)
            return {
                "provider": "kernel_bilibili",
                "profile_id": profile_id,
                "logged_in": profile.get("login_status") == LoginStatus.LOGGED_IN,
                "results": results,
                "has_next_page": has_next_page,
                "total_pages": search_total_pages(payload),
            }
    except TimeoutError as exc:
        raise KernelSearchError("search timed out; retry or use public search") from exc
    finally:
        try:
            if managed is not None:
                try:
                    async with asyncio.timeout(3):
                        await managed.close()
                except TimeoutError:
                    pass
        finally:
            release_profile_reader(profile_id, lease_id, settings)


def search_total_pages(payload: object) -> int | None:
    data = payload.get("data") if isinstance(payload, dict) else None
    value = data.get("numPages") if isinstance(data, dict) else None
    if value is None or isinstance(value, bool):
        return None
    try:
        pages = int(value)
    except (ValueError, TypeError, OverflowError):
        return None
    if pages < 0 or (isinstance(value, float) and not value.is_integer()):
        return None
    if pages == 0 and data.get("result"):
        return None
    return pages


def parse_search_payload(payload: object, page: int, limit: int) -> tuple[list[dict[str, object]], bool]:
    if not isinstance(payload, dict) or payload.get("code", 0) != 0:
        message = payload.get("message", "invalid response") if isinstance(payload, dict) else "invalid response"
        raise KernelSearchError(f"Bilibili search failed: {sanitize_text(message)}")
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("result"), list):
        raise KernelSearchError("Bilibili search returned invalid results")
    raw = data["result"]
    results = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            normalized = _normalize_result(item)
        except (ValueError, TypeError, OverflowError, OSError):
            continue
        bvid = str(normalized["bvid"])
        if bvid and bvid not in seen:
            seen.add(bvid)
            results.append(normalized)
    total_pages = search_total_pages(payload)
    has_more = page < total_pages if total_pages is not None else len(raw) >= limit
    return results[:limit], has_more and page < 10


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
        retry_after = max(1, math.ceil(window_seconds - (now - timestamps[0])))
        raise KernelSearchError("search rate limit exceeded; wait before searching again", 429, retry_after)
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
        return max(0, int(value)) if math.isfinite(value) else None
    text = str(value or "").strip()
    if not text:
        return None
    segments = text.split(":")
    if len(segments) not in (2, 3) or not all(part.isdigit() for part in segments):
        return None
    parts = [int(part) for part in segments]
    if any(part >= 60 for part in parts[1:]):
        return None
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return None


def _parse_pub_time(value: object) -> str | None:
    from datetime import datetime, timezone

    try:
        timestamp = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if timestamp <= 0:
        return None
    try:
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None
