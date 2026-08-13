from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlparse

import httpx

from app.bilibili.bvid import parse_bvid
from app.bilibili.metadata import BilibiliApiError, fetch_metadata
from app.bilibili.playurl import fetch_playurl, select_best_audio
from app.models import StrategyName
from app.security import sanitize_text, sanitize_url
from app.strategies.base import StrategyCancelled, StrategyContext, StrategyResult

DOWNLOAD_CHUNK_SIZE = 1024 * 1024


class ParallelDownloadUnsupported(RuntimeError):
    pass


class ApiDashStrategy:
    name = StrategyName.API_DASH

    def supports(self, context: StrategyContext) -> bool:
        return parse_bvid(context.url) is not None

    async def run(self, context: StrategyContext) -> StrategyResult:
        started = time.perf_counter()
        bvid = parse_bvid(context.url)
        if not bvid:
            return StrategyResult.failed(
                failure_code="BV_PARSE_FAILED",
                reason="Could not parse BV id from URL or BV string",
            )

        context.job_dir.mkdir(parents=True, exist_ok=True)
        raw_path = context.job_dir / "raw.m4s"
        timeout = httpx.Timeout(context.settings.request_timeout_seconds)
        headers = {
            "user-agent": context.settings.bilibili_user_agent,
            "referer": f"https://www.bilibili.com/video/{bvid}",
        }

        try:
            context.raise_if_cancelled()
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                metadata = await fetch_metadata(client, bvid, context.settings.bilibili_user_agent)
                playurl_data = await fetch_playurl(client, metadata, context.settings.bilibili_user_agent)
                audio = select_best_audio(playurl_data)
                download_info = await download_audio(
                    client,
                    audio.url,
                    headers,
                    raw_path,
                    context.settings,
                    context.cancel_requested,
                )
                if not raw_path.exists() or raw_path.stat().st_size == 0:
                    return StrategyResult.failed(
                        failure_code="AUDIO_DOWNLOAD_FAILED",
                        reason="downloaded audio artifact is empty",
                        timings={"duration_ms": _elapsed_ms(started)},
                    )
        except BilibiliApiError as exc:
            return StrategyResult.failed(
                failure_code=exc.failure_code,
                reason=sanitize_text(exc),
                timings={"duration_ms": _elapsed_ms(started)},
            )
        except httpx.HTTPError as exc:
            return StrategyResult.failed(
                failure_code="AUDIO_DOWNLOAD_FAILED",
                reason=sanitize_text(exc),
                timings={"duration_ms": _elapsed_ms(started)},
            )
        except StrategyCancelled:
            raise

        selected_media = {
            "bvid": bvid,
            "audio_id": audio.audio_id,
            "bandwidth": audio.bandwidth,
            "codecs": audio.codecs,
            "mime_type": audio.mime_type,
            "media_host": urlparse(audio.url).netloc,
        }
        return StrategyResult.succeeded(
            reason="Downloaded best DASH audio candidate",
            selected_media=selected_media,
            raw_artifacts=[raw_path],
            timings={"duration_ms": _elapsed_ms(started)},
            sanitized_debug_info={
                "metadata_title": metadata.title,
                "page_cid": metadata.cid,
                "raw_size_bytes": raw_path.stat().st_size,
                "download_mode": download_info["mode"],
                "download_chunks": download_info["chunks"],
            },
        )


async def download_audio(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    output_path: Path,
    settings: object,
    cancel_requested: Callable[[], bool] | None = None,
) -> dict[str, int | str]:
    concurrency = int(getattr(settings, "api_dash_download_concurrency", 1))
    min_parallel_bytes = int(getattr(settings, "api_dash_parallel_min_bytes", 4 * 1024 * 1024))
    if concurrency > 1:
        content_length = await _probe_range_content_length(client, url, headers)
        if content_length and content_length >= min_parallel_bytes:
            ranges = _build_ranges(content_length, concurrency, min_parallel_bytes)
            if len(ranges) > 1:
                try:
                    await _download_ranges(
                        client,
                        url,
                        headers,
                        output_path,
                        ranges,
                        cancel_requested,
                    )
                    return {"mode": "parallel_range", "chunks": len(ranges), "content_length": content_length}
                except (ParallelDownloadUnsupported, httpx.HTTPError):
                    _unlink_if_exists(output_path)

    await _download_sequential(client, url, headers, output_path, cancel_requested)
    return {"mode": "single_stream", "chunks": 1, "content_length": output_path.stat().st_size}


async def _download_sequential(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    output_path: Path,
    cancel_requested: Callable[[], bool] | None = None,
) -> None:
    temp_path = output_path.with_name(f".{output_path.name}.download")
    _unlink_if_exists(temp_path)
    written = 0
    try:
        request_headers = {**headers, "accept-encoding": "identity"}
        async with client.stream("GET", url, headers=request_headers) as response:
            if response.status_code not in {200, 206}:
                raise httpx.HTTPStatusError(
                    f"audio stream HTTP {response.status_code}",
                    request=response.request,
                    response=response,
                )
            expected = _response_content_length(response.headers)
            if response.status_code == 206:
                response_range = _parse_content_range(response.headers.get("content-range"))
                if (
                    response_range is None
                    or response_range[0] != 0
                    or response_range[1] + 1 != response_range[2]
                ):
                    raise httpx.DecodingError(
                        "partial audio response did not contain the full representation"
                    )
                expected = response_range[1] - response_range[0] + 1
            with temp_path.open("wb") as handle:
                async for chunk in response.aiter_raw(chunk_size=DOWNLOAD_CHUNK_SIZE):
                    _raise_if_cancelled(cancel_requested)
                    if chunk:
                        written += len(chunk)
                        handle.write(chunk)
            if expected is not None and written != expected:
                raise httpx.DecodingError(
                    f"audio response size mismatch: expected {expected}, received {written}"
                )
        temp_path.replace(output_path)
    finally:
        _unlink_if_exists(temp_path)


async def _probe_range_content_length(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
) -> int | None:
    probe_headers = {**headers, "range": "bytes=0-0"}
    async with client.stream("GET", url, headers=probe_headers) as response:
        if response.status_code != 206:
            return None
        parsed = _parse_content_range(response.headers.get("content-range"))
        if parsed is None or parsed[:2] != (0, 0):
            return None
        return parsed[2]


async def _download_ranges(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    output_path: Path,
    ranges: list[tuple[int, int]],
    cancel_requested: Callable[[], bool] | None = None,
) -> None:
    part_paths = [output_path.with_name(f"{output_path.name}.part{index}") for index in range(len(ranges))]
    merged_path = output_path.with_name(f".{output_path.name}.merge")
    _unlink_if_exists(merged_path)
    tasks = [
        asyncio.create_task(
            _download_range_part(
                client,
                url,
                headers,
                part_path,
                byte_range,
                cancel_requested,
            )
        )
        for part_path, byte_range in zip(part_paths, ranges)
    ]
    try:
        try:
            await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        with merged_path.open("wb") as merged:
            for part_path in part_paths:
                _raise_if_cancelled(cancel_requested)
                with part_path.open("rb") as part:
                    while True:
                        chunk = part.read(DOWNLOAD_CHUNK_SIZE)
                        if not chunk:
                            break
                        merged.write(chunk)
        merged_path.replace(output_path)
    finally:
        for part_path in part_paths:
            _unlink_if_exists(part_path)
        _unlink_if_exists(merged_path)


async def _download_range_part(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    output_path: Path,
    byte_range: tuple[int, int],
    cancel_requested: Callable[[], bool] | None = None,
) -> None:
    start, end = byte_range
    expected_size = end - start + 1
    range_headers = {**headers, "range": f"bytes={start}-{end}"}
    size = 0
    async with client.stream("GET", url, headers=range_headers) as response:
        if response.status_code != 206:
            raise ParallelDownloadUnsupported(f"range request HTTP {response.status_code}")
        response_range = _parse_content_range(response.headers.get("content-range"))
        if response_range is None or response_range[:2] != (start, end):
            raise ParallelDownloadUnsupported("range response Content-Range mismatch")
        with output_path.open("wb") as handle:
            async for chunk in response.aiter_raw(chunk_size=DOWNLOAD_CHUNK_SIZE):
                _raise_if_cancelled(cancel_requested)
                if chunk:
                    size += len(chunk)
                    handle.write(chunk)
    if size != expected_size:
        raise ParallelDownloadUnsupported("range response size mismatch")


def _build_ranges(content_length: int, concurrency: int, min_parallel_bytes: int) -> list[tuple[int, int]]:
    if content_length <= 0:
        return []
    chunk_count = max(1, min(concurrency, (content_length + min_parallel_bytes - 1) // min_parallel_bytes))
    chunk_size = (content_length + chunk_count - 1) // chunk_count
    ranges = []
    for index in range(chunk_count):
        start = index * chunk_size
        if start >= content_length:
            break
        end = min(content_length - 1, start + chunk_size - 1)
        ranges.append((start, end))
    return ranges


def _parse_content_range_total(value: str | None) -> int | None:
    parsed_range = _parse_content_range(value)
    return parsed_range[2] if parsed_range else None


def _parse_content_range(value: str | None) -> tuple[int, int, int] | None:
    if not value:
        return None
    try:
        unit_and_range, total_text = value.split("/", 1)
        unit, byte_range = unit_and_range.split(" ", 1)
        start_text, end_text = byte_range.split("-", 1)
    except ValueError:
        return None
    if unit.lower() != "bytes" or total_text == "*":
        return None
    try:
        start = int(start_text)
        end = int(end_text)
        total = int(total_text)
    except ValueError:
        return None
    if start < 0 or end < start or total <= end:
        return None
    return start, end, total


def _response_content_length(headers: object) -> int | None:
    raw = headers.get("content-length") if hasattr(headers, "get") else None
    if raw is None:
        return None
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _raise_if_cancelled(cancel_requested: Callable[[], bool] | None) -> None:
    if cancel_requested and cancel_requested():
        raise StrategyCancelled("Job cancelled during audio download")


def _unlink_if_exists(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)
