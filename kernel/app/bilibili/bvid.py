from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse


BVID_RE = re.compile(r"(?P<bvid>BV[0-9A-Za-z]{10})")


def parse_bvid(value: str) -> str | None:
    text = (value or "").strip()
    if not text:
        return None

    query_bvid = parse_qs(urlparse(text).query).get("bvid")
    if query_bvid:
        match = BVID_RE.fullmatch(query_bvid[0])
        if match:
            return match.group("bvid")

    match = BVID_RE.search(text)
    return match.group("bvid") if match else None


def normalize_video_url(value: str) -> str:
    bvid = parse_bvid(value)
    if not bvid:
        raise ValueError("missing BV id")
    return f"https://www.bilibili.com/video/{bvid}"
