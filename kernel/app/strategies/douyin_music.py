from __future__ import annotations

import asyncio
import time
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

import httpx

from app.douyin.detail import (
    DouyinAweme,
    DouyinUnavailable,
    MediaHostNotAllowed,
    browser_sandbox_active,
    fetch_aweme_detail,
    reject_disallowed_media_host,
    resolve_short_link,
)
from app.douyin.links import parse_douyin_url
from app.media_pipeline import audio_only_problem, ffmpeg_extract_audio, ffprobe_json
from app.models import StrategyName
from app.security import sanitize_text
from app.strategies.api_dash import DownloadTooLarge, download_audio
from app.strategies.base import StrategyCancelled, StrategyContext, StrategyResult

MUSIC_EXTENSIONS = {".mp3", ".m4a", ".aac"}
# Slow page loads, a briefly full browser pool and transient browser/network
# errors are worth one more try inside a job; missing or private items are not.
RETRYABLE_DETAIL_FAILURES = {"DOUYIN_DETAIL_TIMEOUT", "DOUYIN_BUSY", "DOUYIN_BROWSER_CRASHED"}
DETAIL_RETRY_DELAY_SECONDS = 2.0
DOWNLOAD_PASSES = 2
# Douyin's CDN serves one connection at roughly 1 MB/s; ranged parts of at least
# 1 MiB in parallel cut long originals to a fraction of that time.
PARALLEL_PART_MIN_BYTES = 1024 * 1024


class DouyinMusicStrategy:
    """Download a public Douyin item's background music as published.

    The item's music track is Douyin's own standalone audio file, so it is kept
    byte-for-byte. Items without one fall back to copying the audio stream out
    of the item's video; the video itself is discarded.
    """

    name = StrategyName.DOUYIN_MUSIC

    def supports(self, context: StrategyContext) -> bool:
        try:
            return parse_douyin_url(context.url) is not None
        except ValueError:
            return False

    async def run(self, context: StrategyContext) -> StrategyResult:
        started = time.perf_counter()
        try:
            ref = parse_douyin_url(context.url)
        except ValueError as exc:
            return StrategyResult.failed(failure_code="DOUYIN_URL_INVALID", reason=sanitize_text(exc))
        if ref is None:
            return StrategyResult.failed(failure_code="DOUYIN_URL_INVALID", reason="not a Douyin link")

        context.job_dir.mkdir(parents=True, exist_ok=True)
        try:
            context.raise_if_cancelled()
            aweme_id = ref.aweme_id or await resolve_short_link(ref.canonical_url, context.settings)
            context.raise_if_cancelled()
            aweme = await _fetch_detail_with_retry(aweme_id, context)
            context.raise_if_cancelled()
            if aweme.music_urls:
                raw_path, media_url, download_info = await _download_music(context, aweme)
                media_kind = "music"
            elif aweme.video_urls:
                raw_path, media_url, download_info = await _extract_video_audio(context, aweme)
                media_kind = "video_audio"
            else:
                return StrategyResult.failed(
                    failure_code="DOUYIN_NO_MEDIA",
                    reason="Douyin item has no downloadable music or video",
                    timings={"duration_ms": _elapsed_ms(started)},
                )
        except DouyinUnavailable as exc:
            return StrategyResult.failed(
                failure_code=exc.failure_code,
                reason=sanitize_text(exc.reason),
                timings={"duration_ms": _elapsed_ms(started)},
            )
        except MediaHostNotAllowed as exc:
            return StrategyResult.failed(
                failure_code="MEDIA_HOST_NOT_ALLOWED",
                reason=sanitize_text(exc),
                timings={"duration_ms": _elapsed_ms(started)},
            )
        except DownloadTooLarge as exc:
            return StrategyResult.failed(
                failure_code="MEDIA_TOO_LARGE",
                reason=f"{sanitize_text(exc)} (DOUYIN_MAX_DOWNLOAD_BYTES)",
                timings={"duration_ms": _elapsed_ms(started)},
            )
        except httpx.HTTPError as exc:
            return StrategyResult.failed(
                failure_code="AUDIO_DOWNLOAD_FAILED",
                reason=sanitize_text(exc),
                timings={"duration_ms": _elapsed_ms(started)},
            )
        except _AudioExtractionFailed as exc:
            return StrategyResult.failed(
                failure_code="AUDIO_EXTRACT_FAILED",
                reason=sanitize_text(exc),
                timings={"duration_ms": _elapsed_ms(started)},
            )
        except StrategyCancelled:
            raise

        music = aweme.music
        selected_media = {
            "source": "douyin",
            "aweme_id": aweme.aweme_id,
            "media_kind": media_kind,
            "media_host": urlparse(media_url).netloc,
            "music_title": music.title if music else None,
            "music_author": music.author if music else None,
        }
        return StrategyResult.succeeded(
            reason=(
                "Downloaded the item's background music"
                if media_kind == "music"
                else "Copied the audio stream from the item's video"
            ),
            selected_media=selected_media,
            raw_artifacts=[raw_path],
            timings={"duration_ms": _elapsed_ms(started)},
            sanitized_debug_info={
                "title": aweme.desc[:200],
                "author": aweme.author,
                "raw_size_bytes": raw_path.stat().st_size,
                "download_mode": download_info["mode"],
                "download_chunks": download_info["chunks"],
                "browser_sandbox": browser_sandbox_active(),
            },
        )


class _AudioExtractionFailed(RuntimeError):
    pass


async def _fetch_detail_with_retry(aweme_id: str, context: StrategyContext) -> DouyinAweme:
    for attempt in range(2):
        try:
            return await fetch_aweme_detail(aweme_id, context.settings, context.raise_if_cancelled)
        except StrategyCancelled:
            raise
        except DouyinUnavailable as exc:
            if attempt or exc.failure_code not in RETRYABLE_DETAIL_FAILURES:
                raise
        except Exception:
            # Browser start-up, navigation or crash errors from Playwright.
            if attempt:
                raise
        await asyncio.sleep(DETAIL_RETRY_DELAY_SECONDS)
        context.raise_if_cancelled()
    raise AssertionError("unreachable")


# Leading bytes of the containers Douyin serves. A CDN error page answered with
# HTTP 200 must not be published as audio.
def _looks_like_media(path: Path) -> bool:
    with path.open("rb") as handle:
        head = handle.read(12)
    if len(head) < 4:
        return False
    return (
        head.startswith(b"ID3")                                   # MP3 with ID3 tag
        or (head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)          # MPEG / ADTS frame sync
        or head[4:8] == b"ftyp"                                    # MP4 / M4A
        or head.startswith((b"OggS", b"fLaC", b"RIFF"))
    )


async def _download_music(context: StrategyContext, aweme: DouyinAweme) -> tuple[Path, str, dict[str, object]]:
    urls = aweme.music_urls
    suffix = PurePosixPath(urlparse(urls[0]).path).suffix.lower()
    raw_path = context.job_dir / f"raw{suffix if suffix in MUSIC_EXTENSIONS else '.mp3'}"
    media_url, info = await _download_first(context, urls, raw_path)
    return raw_path, media_url, info


async def _extract_video_audio(context: StrategyContext, aweme: DouyinAweme) -> tuple[Path, str, dict[str, object]]:
    video_path = context.job_dir / "source_video.mp4"
    raw_path = context.job_dir / "raw.m4a"
    try:
        media_url, info = await _download_first(context, aweme.video_urls, video_path)
        context.raise_if_cancelled()
        warning = await asyncio.to_thread(ffmpeg_extract_audio, video_path, raw_path, context.cancel_requested)
        if warning:
            raise _AudioExtractionFailed(warning)
        probe, probe_warning = await asyncio.to_thread(ffprobe_json, raw_path, context.cancel_requested)
        problem = probe_warning or audio_only_problem(probe)
        if problem:
            raw_path.unlink(missing_ok=True)
            raise _AudioExtractionFailed(f"extracted file is not audio-only: {problem}")
    finally:
        # Only the audio is kept; the downloaded video never becomes an artifact.
        video_path.unlink(missing_ok=True)
    return raw_path, media_url, info


async def _download_first(
    context: StrategyContext,
    urls: list[str],
    output_path: Path,
) -> tuple[str, dict[str, object]]:
    """Try each CDN mirror in turn (two passes) until one yields a real media file."""
    headers = {
        "user-agent": context.settings.bilibili_user_agent,
        "referer": "https://www.douyin.com/",
    }
    timeout = httpx.Timeout(context.settings.request_timeout_seconds)
    last_error: httpx.HTTPError | None = None
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=True,
        event_hooks={"request": [reject_disallowed_media_host]},
    ) as client:
        for attempt in range(DOWNLOAD_PASSES):
            if attempt:
                await asyncio.sleep(1.0)
            for url in urls:
                context.raise_if_cancelled()
                try:
                    info = await download_audio(
                        client,
                        url,
                        headers,
                        output_path,
                        context.settings,
                        context.cancel_requested,
                        concurrency=context.settings.douyin_download_concurrency,
                        min_parallel_bytes=PARALLEL_PART_MIN_BYTES,
                        max_bytes=context.settings.douyin_max_download_bytes,
                    )
                except httpx.HTTPError as exc:
                    last_error = exc
                    continue
                if output_path.exists() and output_path.stat().st_size > 0 and _looks_like_media(output_path):
                    return url, info
                output_path.unlink(missing_ok=True)
                last_error = httpx.DecodingError("downloaded file is not a media file")
    raise last_error or httpx.DecodingError("no media URL could be downloaded")


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)
