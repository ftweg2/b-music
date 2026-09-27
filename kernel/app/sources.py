from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

from .douyin.links import is_douyin_host, parse_douyin_url
from .models import SourceName
from .security import validate_bilibili_video_ref


# Only Bilibili strategies open the owner's logged-in profile. Jobs for other
# sources must not take (or wait for) that profile's single job lock.
PROFILE_BOUND_SOURCES = frozenset({SourceName.BILIBILI})


@dataclass(frozen=True)
class VideoRef:
    source: str
    canonical_url: str


def validate_video_ref(value: str) -> VideoRef:
    """Validate a job URL without network access and return its canonical form."""
    douyin = parse_douyin_url(value)
    if douyin is not None:
        return VideoRef(source=SourceName.DOUYIN, canonical_url=douyin.canonical_url)
    bvid = validate_bilibili_video_ref(value)
    return VideoRef(source=SourceName.BILIBILI, canonical_url=f"https://www.bilibili.com/video/{bvid}")


def source_for_url(url: str) -> str:
    """Return the source of a canonical URL that was stored by validate_video_ref."""
    if is_douyin_host(urlparse(url).hostname):
        return SourceName.DOUYIN
    return SourceName.BILIBILI
