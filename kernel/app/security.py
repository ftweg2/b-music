from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse, urlunparse

from .bilibili.bvid import parse_bvid


SENSITIVE_WORDS = (
    "cookie",
    "authorization",
    "sessdata",
    "bili_jct",
    "dedeuserid",
    "access_key",
    "csrf",
    "token",
    "localstorage",
    "sessionstorage",
    "storage_state",
)

ALLOWED_VIDEO_HOSTS = {
    "bilibili.com",
    "www.bilibili.com",
    "m.bilibili.com",
    "space.bilibili.com",
}


def is_bilibili_host(host: str | None) -> bool:
    normalized = (host or "").strip().lower().rstrip(".")
    return normalized == "bilibili.com" or normalized.endswith(".bilibili.com")


def sanitize_url(url: str | None) -> str | None:
    if not url:
        return url
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return sanitize_text(url)
    safe_netloc = parsed.hostname or ""
    safe_query = ""
    if parsed.query:
        safe_query = "<redacted>"
    return urlunparse((parsed.scheme, safe_netloc, parsed.path, "", safe_query, ""))


def sanitize_text(value: object, max_length: int = 1500) -> str:
    text = str(value)
    # Header syntax commonly separates the name from its value with a space
    # (for example ``Authorization Bearer …``), not only ``:`` or ``=``.
    # Redact the complete value through the end of the header line.
    text = re.sub(
        r"((?:authorization|proxy-authorization)\s+(?:(?:bearer|basic)\s+)?)"
        r"[^,;\r\n]+",
        r"\1<redacted>",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"((?:cookie|set-cookie)\s*(?::|=|\s)\s*)[^,;\r\n]+",
        r"\1<redacted>",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"(authorization\s*[=:]\s*)(?:(?:bearer|basic)\s+)?[^,\s;]+",
        r"\1<redacted>",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"((?:authorization|cookie|sessdata|bili_jct|dedeuserid|access_key|csrf|token|"
        r"localstorage|sessionstorage|storage_state)[\"']?\s*:\s*[\"'])(.*?)([\"'])",
        r"\1<redacted>\3",
        text,
        flags=re.IGNORECASE,
    )
    for word in SENSITIVE_WORDS:
        text = re.sub(
            rf"({re.escape(word)}\s*[=:]\s*)[^,\s;]+",
            rf"\1<redacted>",
            text,
            flags=re.IGNORECASE,
        )
    text = re.sub(r"https?://[^\s\"']+", lambda m: sanitize_url(m.group(0)) or "", text)
    return text[:max_length]


def sanitize_dict(data: dict[str, object]) -> dict[str, object]:
    sanitized: dict[str, object] = {}
    for key, value in data.items():
        if any(word in key.lower() for word in SENSITIVE_WORDS):
            sanitized[key] = "<redacted>"
        else:
            sanitized[key] = sanitize_value(value)
    return sanitized


def sanitize_value(value: object) -> object:
    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, dict):
        return sanitize_dict(value)
    if isinstance(value, list):
        return [sanitize_value(item) for item in value]
    return value


def validate_external_owner_id(external_owner_id: str) -> None:
    if not external_owner_id or len(external_owner_id) > 128:
        raise ValueError("external_owner_id must be 1-128 characters")
    if not re.fullmatch(r"[A-Za-z0-9_.:@-]+", external_owner_id):
        raise ValueError("external_owner_id contains unsupported characters")


def validate_job_id(job_id: str) -> None:
    if not job_id or len(job_id) > 128:
        raise ValueError("job_id must be 1-128 characters")
    if not re.fullmatch(r"[A-Za-z0-9_.:@-]+", job_id):
        raise ValueError("job_id contains unsupported characters")


def validate_login_session_id(login_session_id: str) -> None:
    if not re.fullmatch(r"ls_[A-Za-z0-9]{12,40}", login_session_id or ""):
        raise ValueError("invalid login_session_id")


def validate_profile_id(profile_id: str) -> None:
    if not re.fullmatch(r"p_[A-Za-z0-9]{12,40}", profile_id or ""):
        raise ValueError("invalid profile_id")


def validate_bilibili_video_ref(value: str) -> str:
    bvid = parse_bvid(value)
    if not bvid:
        raise ValueError("url must contain a valid Bilibili BV id")
    parsed = urlparse(value)
    if parsed.scheme or parsed.netloc:
        host = parsed.netloc.lower()
        if host not in ALLOWED_VIDEO_HOSTS:
            raise ValueError("url host must be a Bilibili video host")
        if "/video/" not in parsed.path and not parse_qs(parsed.query).get("bvid"):
            raise ValueError("url must be a Bilibili video URL")
    return bvid
