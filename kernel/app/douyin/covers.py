"""Kernel-side cache of Douyin cover images.

Douyin only hands out signed, expiring cover URLs. Instead of passing those to
clients (or working around the signature), the kernel downloads the cover once,
through the URL the public page itself provided, and serves the stored image by
item id. Clients never see a Douyin image URL.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import urlparse

import httpx

from app.config import Settings
from app.douyin.detail import DouyinAweme
from app.douyin.links import normalize_host


COVER_HOST_SUFFIX = "douyinpic.com"
MAX_COVER_BYTES = 2 * 1024 * 1024
MAX_STORED_COVERS = 2000
AWEME_ID_RE = re.compile(r"\d{15,20}")
IMAGE_TYPES = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}


class CoverRejected(RuntimeError):
    pass


def covers_dir(settings: Settings) -> Path:
    return settings.data_dir / "douyin-covers"


def is_allowed_cover_url(url: str) -> bool:
    parsed = urlparse(url or "")
    host = normalize_host(parsed.hostname)
    return (
        parsed.scheme == "https"
        and not parsed.username
        and not parsed.password
        and (host == COVER_HOST_SUFFIX or host.endswith("." + COVER_HOST_SUFFIX))
    )


def image_extension(head: bytes) -> str | None:
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    return None


def cover_path(aweme_id: str, settings: Settings) -> Path | None:
    if not AWEME_ID_RE.fullmatch(aweme_id or ""):
        return None
    for extension in IMAGE_TYPES:
        candidate = covers_dir(settings) / f"{aweme_id}{extension}"
        if candidate.is_file():
            return candidate
    return None


async def store_cover(
    aweme: DouyinAweme,
    settings: Settings,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bool:
    """Cache the item's cover if it is not cached yet. Best effort: returns False on failure."""
    if not AWEME_ID_RE.fullmatch(aweme.aweme_id):
        return False
    if cover_path(aweme.aweme_id, settings):
        return True
    urls = [url for url in aweme.cover_urls if is_allowed_cover_url(url)]
    if not urls:
        return False
    directory = covers_dir(settings)
    directory.mkdir(parents=True, exist_ok=True)

    async def only_douyin_images(request: httpx.Request) -> None:
        if not is_allowed_cover_url(str(request.url)):
            raise CoverRejected("cover redirected outside Douyin's image CDN")

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(min(15.0, settings.request_timeout_seconds)),
        follow_redirects=True,
        transport=transport,
        event_hooks={"request": [only_douyin_images]},
        headers={"user-agent": settings.bilibili_user_agent, "referer": "https://www.douyin.com/"},
    ) as client:
        for url in urls:
            try:
                data = await _download_image(client, url)
            except (httpx.HTTPError, CoverRejected):
                continue
            extension = image_extension(data[:16])
            if not extension:
                continue
            target = directory / f"{aweme.aweme_id}{extension}"
            temp = directory / f".{aweme.aweme_id}{extension}.tmp"
            temp.write_bytes(data)
            os.replace(temp, target)
            _prune(directory)
            return True
    return False


async def _download_image(client: httpx.AsyncClient, url: str) -> bytes:
    async with client.stream("GET", url) as response:
        if response.status_code != 200:
            raise CoverRejected(f"cover HTTP {response.status_code}")
        content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
        if content_type not in IMAGE_TYPES.values():
            raise CoverRejected(f"cover content type {content_type or 'missing'}")
        chunks: list[bytes] = []
        size = 0
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > MAX_COVER_BYTES:
                raise CoverRejected("cover is larger than allowed")
            chunks.append(chunk)
    return b"".join(chunks)


def _prune(directory: Path) -> None:
    files = [path for path in directory.iterdir() if path.is_file() and not path.name.startswith(".")]
    if len(files) <= MAX_STORED_COVERS:
        return
    files.sort(key=lambda path: path.stat().st_mtime)
    for path in files[: len(files) - MAX_STORED_COVERS]:
        path.unlink(missing_ok=True)
