from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse


# Page hosts can carry an item id directly. Short links only carry a share code
# and are resolved inside a job, so job creation stays network-free.
DOUYIN_PAGE_HOSTS = frozenset({
    "douyin.com",
    "www.douyin.com",
    "m.douyin.com",
    "iesdouyin.com",
    "www.iesdouyin.com",
})
DOUYIN_SHORT_LINK_HOSTS = frozenset({"v.douyin.com"})

AWEME_ID_RE = re.compile(r"\d{15,20}")
_PATH_ID_RE = re.compile(r"^/(?:share/)?(?:video|note|slides)/(\d{15,20})/?$")
_SHORT_CODE_RE = re.compile(r"^/([A-Za-z0-9_-]{4,32})/?$")
_QUERY_ID_KEYS = ("modal_id", "aweme_id")


@dataclass(frozen=True)
class DouyinRef:
    aweme_id: str | None = None
    short_code: str | None = None

    @property
    def canonical_url(self) -> str:
        if self.aweme_id:
            return canonical_video_url(self.aweme_id)
        return f"https://v.douyin.com/{self.short_code}/"


def canonical_video_url(aweme_id: str) -> str:
    return f"https://www.douyin.com/video/{aweme_id}"


def normalize_host(host: str | None) -> str:
    return (host or "").strip().lower().rstrip(".")


def is_douyin_host(host: str | None) -> bool:
    normalized = normalize_host(host)
    return normalized in DOUYIN_PAGE_HOSTS or normalized in DOUYIN_SHORT_LINK_HOSTS


def aweme_id_from_url(value: str) -> str | None:
    """Return the item id carried by a Douyin page URL, or None."""
    parsed = urlparse(value or "")
    if normalize_host(parsed.hostname) not in DOUYIN_PAGE_HOSTS:
        return None
    match = _PATH_ID_RE.match(parsed.path or "")
    if match:
        return match.group(1)
    query = parse_qs(parsed.query)
    for key in _QUERY_ID_KEYS:
        for candidate in query.get(key, []):
            if AWEME_ID_RE.fullmatch(candidate):
                return candidate
    return None


def parse_douyin_url(value: str) -> DouyinRef | None:
    """Parse a Douyin link.

    Returns None when the value is not on a Douyin host, so callers can fall
    back to other sources. Raises ValueError for Douyin links that carry no
    usable item id or share code.
    """
    text = (value or "").strip()
    parsed = urlparse(text)
    host = normalize_host(parsed.hostname)
    if not is_douyin_host(host):
        return None
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Douyin url must use http or https")
    if parsed.username or parsed.password or parsed.port is not None:
        raise ValueError("Douyin url must not contain credentials or a port")
    if host in DOUYIN_SHORT_LINK_HOSTS:
        match = _SHORT_CODE_RE.match(parsed.path or "")
        if not match:
            raise ValueError("Douyin short link must look like https://v.douyin.com/<code>/")
        return DouyinRef(short_code=match.group(1))
    aweme_id = aweme_id_from_url(text)
    if not aweme_id:
        raise ValueError("Douyin url must contain a video id")
    return DouyinRef(aweme_id=aweme_id)
