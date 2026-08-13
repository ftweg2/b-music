from __future__ import annotations

import asyncio
import hashlib
import time
from pathlib import Path
from pathlib import PurePosixPath
from urllib.parse import urlencode, urlparse

import httpx

from app.bilibili.bvid import normalize_video_url, parse_bvid
from app.bilibili.playurl import select_best_audio
from app.bilibili.wbi import MIXIN_KEY_ENC_TAB
from app.browser.context_manager import BrowserContextManager
from app.browser.network_capture import MediaCandidate, NetworkCapture
from app.media_pipeline import ffprobe_json
from app.models import StrategyName
from app.security import sanitize_text
from app.strategies.base import StrategyCancelled, StrategyContext, StrategyResult


DOWNLOAD_CHUNK_SIZE = 1024 * 1024


class MediaDownloadError(RuntimeError):
    pass


class BrowserNetworkStrategy:
    name = StrategyName.BROWSER_NETWORK

    def supports(self, context: StrategyContext) -> bool:
        return parse_bvid(context.url) is not None

    async def run(self, context: StrategyContext) -> StrategyResult:
        started = time.perf_counter()
        context.job_dir.mkdir(parents=True, exist_ok=True)
        raw_path = context.job_dir / "raw.m4s"
        manager = BrowserContextManager(context.settings)
        managed = None
        capture = None

        try:
            video_url = normalize_video_url(context.url)
            managed = await manager.open_context(context.profile_id)
            page = await managed.context.new_page()
            capture = NetworkCapture()
            capture.attach(page)

            await page.goto(
                video_url,
                wait_until="domcontentloaded",
                timeout=int(context.settings.request_timeout_seconds * 1000),
            )
            await _trigger_player_load(page)
            await _wait_with_cancellation(
                page,
                context.settings.network_capture_ms,
                context,
            )
            await capture.finish()
            context.raise_if_cancelled()

            candidate = capture.best_candidate()
            if not candidate:
                bvid = parse_bvid(context.url)
                if bvid:
                    candidate = await _candidate_from_context_playurl(
                        managed.context,
                        bvid,
                        context.settings.bilibili_user_agent,
                    )
                if not candidate:
                    return StrategyResult.failed(
                        failure_code="MEDIA_CANDIDATE_NOT_FOUND",
                        reason="No likely audio media request was captured",
                        timings={"duration_ms": _elapsed_ms(started)},
                        sanitized_debug_info={
                            "capture": capture.sanitized_summary(),
                            "candidates": capture.sanitized_candidates(),
                        },
                    )

            await _download_candidate(
                managed.context,
                candidate.actual_url,
                raw_path,
                headers={
                    "referer": video_url,
                    "user-agent": context.settings.bilibili_user_agent,
                },
                timeout=int(context.settings.request_timeout_seconds * 1000),
                context=context,
            )
            if not raw_path.exists() or raw_path.stat().st_size == 0:
                return StrategyResult.failed(
                    failure_code="AUDIO_DOWNLOAD_FAILED",
                    reason="captured media response body was empty",
                    timings={"duration_ms": _elapsed_ms(started)},
                    sanitized_debug_info={
                        "capture": capture.sanitized_summary(),
                        "candidate": candidate.sanitized_dict(),
                    },
                )
            probe, probe_warning = await asyncio.to_thread(
                ffprobe_json,
                raw_path,
                context.cancel_requested,
            )
            context.raise_if_cancelled()
            probe_summary = _audio_probe_summary(probe)
            if probe_warning or not probe_summary["has_audio"] or probe_summary["has_video"]:
                try:
                    raw_path.unlink()
                except FileNotFoundError:
                    pass
                failure_code = (
                    "AUDIO_VALIDATION_FAILED"
                    if probe_warning
                    else "CAPTURED_MEDIA_NOT_AUDIO"
                )
                reason = (
                    "Downloaded media could not be validated as audio"
                    if probe_warning
                    else "Captured media candidate was not an audio-only stream"
                )
                return StrategyResult.failed(
                    failure_code=failure_code,
                    reason=reason,
                    timings={"duration_ms": _elapsed_ms(started)},
                    sanitized_debug_info={
                        "capture": capture.sanitized_summary(),
                        "candidate": candidate.sanitized_dict(),
                        "probe": probe_summary,
                        "probe_warning": sanitize_text(probe_warning) if probe_warning else None,
                    },
                )
            return StrategyResult.succeeded(
                reason="Downloaded original media candidate from authenticated BrowserContext",
                selected_media=candidate.sanitized_dict(),
                raw_artifacts=[raw_path],
                timings={"duration_ms": _elapsed_ms(started)},
                sanitized_debug_info={
                    "candidate_count": len(capture.sanitized_candidates(limit=100)),
                    "capture": capture.sanitized_summary(),
                    "top_candidates": capture.sanitized_candidates(),
                    "raw_size_bytes": raw_path.stat().st_size,
                },
            )
        except StrategyCancelled:
            raise
        except MediaDownloadError as exc:
            return StrategyResult.failed(
                failure_code="AUDIO_DOWNLOAD_FAILED",
                reason=sanitize_text(exc),
                timings={"duration_ms": _elapsed_ms(started)},
                sanitized_debug_info={
                    "capture": capture.sanitized_summary() if capture else {},
                },
            )
        except Exception as exc:
            return StrategyResult.failed(
                failure_code="BROWSER_NETWORK_FAILED",
                reason=sanitize_text(exc),
                timings={"duration_ms": _elapsed_ms(started)},
            )
        finally:
            if capture is not None:
                try:
                    await capture.finish()
                except Exception:
                    pass
            if managed is not None:
                try:
                    await managed.close()
                except Exception:
                    pass


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _audio_probe_summary(probe: dict[str, object] | None) -> dict[str, object]:
    """Return only the non-sensitive stream facts needed to validate a capture."""
    streams = probe.get("streams") if isinstance(probe, dict) else None
    stream_items = streams if isinstance(streams, list) else []
    codec_types: list[str] = []
    audio_codecs: list[str] = []
    video_codecs: list[str] = []
    for stream in stream_items:
        if not isinstance(stream, dict):
            continue
        codec_type = str(stream.get("codec_type") or "").lower()
        codec_name = str(stream.get("codec_name") or "").lower()
        if codec_type:
            codec_types.append(codec_type)
        if codec_type == "audio" and codec_name:
            audio_codecs.append(codec_name)
        elif codec_type == "video" and codec_name:
            video_codecs.append(codec_name)
    return {
        "has_audio": "audio" in codec_types,
        "has_video": "video" in codec_types,
        "codec_types": sorted(set(codec_types)),
        "audio_codecs": sorted(set(audio_codecs)),
        "video_codecs": sorted(set(video_codecs)),
    }


async def _wait_with_cancellation(
    page: object,
    wait_ms: int,
    context: StrategyContext,
) -> None:
    remaining = max(0, wait_ms)
    while remaining > 0:
        context.raise_if_cancelled()
        interval = min(500, remaining)
        await page.wait_for_timeout(interval)
        remaining -= interval


async def _download_candidate(
    browser_context: object,
    url: str,
    output_path: Path,
    *,
    headers: dict[str, str],
    timeout: int,
    context: StrategyContext,
) -> None:
    temp_path = output_path.with_name(f".{output_path.name}.download")
    cookie_jar = httpx.Cookies()
    try:
        for cookie in await browser_context.cookies([url]):
            cookie_jar.set(
                str(cookie["name"]),
                str(cookie["value"]),
                domain=str(cookie.get("domain") or ""),
                path=str(cookie.get("path") or "/"),
            )
        request_headers = {**headers, "accept-encoding": "identity"}
        timeout_seconds = max(0.001, timeout / 1000)
        written = 0
        async with httpx.AsyncClient(
            cookies=cookie_jar,
            follow_redirects=True,
            timeout=httpx.Timeout(timeout_seconds),
        ) as client:
            async with client.stream("GET", url, headers=request_headers) as response:
                if response.status_code not in {200, 206}:
                    raise MediaDownloadError(
                        f"captured media download HTTP {response.status_code}"
                    )
                expected = _content_length(response.headers.get("content-length"))
                if response.status_code == 206:
                    content_range = _content_range(response.headers.get("content-range"))
                    if (
                        content_range is None
                        or content_range[0] != 0
                        or content_range[1] + 1 != content_range[2]
                    ):
                        raise MediaDownloadError(
                            "captured partial response did not contain the full representation"
                        )
                    expected = content_range[1] - content_range[0] + 1
                with temp_path.open("wb") as handle:
                    async for chunk in response.aiter_raw(chunk_size=DOWNLOAD_CHUNK_SIZE):
                        context.raise_if_cancelled()
                        if chunk:
                            handle.write(chunk)
                            written += len(chunk)
                if expected is not None and written != expected:
                    raise MediaDownloadError(
                        f"captured media size mismatch: expected {expected}, received {written}"
                    )
        if written == 0:
            raise MediaDownloadError("captured media response body was empty")
        temp_path.replace(output_path)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def _content_length(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def _content_range(value: str | None) -> tuple[int, int, int] | None:
    if not value:
        return None
    try:
        unit_and_range, total_text = value.split("/", 1)
        unit, byte_range = unit_and_range.split(" ", 1)
        start_text, end_text = byte_range.split("-", 1)
        start, end, total = int(start_text), int(end_text), int(total_text)
    except ValueError:
        return None
    if unit.lower() != "bytes" or start < 0 or end < start or total <= end:
        return None
    return start, end, total


async def _trigger_player_load(page: object) -> None:
    try:
        await page.locator("video").first.click(timeout=3000)
    except Exception:
        pass
    try:
        await page.keyboard.press("Space")
    except Exception:
        pass
    try:
        await page.mouse.wheel(0, 500)
    except Exception:
        pass


async def _candidate_from_context_playurl(
    browser_context: object,
    bvid: str,
    user_agent: str,
) -> MediaCandidate | None:
    request_context = browser_context.request
    headers = {
        "user-agent": user_agent,
        "referer": f"https://www.bilibili.com/video/{bvid}",
    }
    metadata_response = await request_context.get(
        "https://api.bilibili.com/x/web-interface/view",
        params={"bvid": bvid},
        headers=headers,
    )
    if metadata_response.status != 200:
        return None
    metadata_payload = await metadata_response.json()
    if metadata_payload.get("code") != 0:
        return None
    metadata = metadata_payload.get("data") or {}
    pages = metadata.get("pages") or []
    if not pages:
        return None

    params = {
        "avid": int(metadata["aid"]),
        "bvid": bvid,
        "cid": int(pages[0]["cid"]),
        "qn": 127,
        "fnval": 16,
        "fourk": 1,
    }
    signed = await _sign_wbi_params_with_context(request_context, params, user_agent)
    playurl_response = await request_context.get(
        "https://api.bilibili.com/x/player/wbi/playurl",
        params=signed,
        headers=headers,
    )
    if playurl_response.status != 200:
        return None
    playurl_payload = await playurl_response.json()
    if playurl_payload.get("code") != 0:
        return None
    audio = select_best_audio(playurl_payload.get("data") or {})
    return MediaCandidate(
        actual_url=audio.url,
        sanitized_url=None,
        status=200,
        resource_type="xhr",
        content_type=audio.mime_type or "audio/mp4",
        content_length=0,
        score=100.0,
        reasons=["browser_context_playurl_dash_audio"],
    )


async def _sign_wbi_params_with_context(
    request_context: object,
    params: dict[str, object],
    user_agent: str,
) -> dict[str, object]:
    nav_response = await request_context.get(
        "https://api.bilibili.com/x/web-interface/nav",
        headers={"user-agent": user_agent, "referer": "https://www.bilibili.com/"},
    )
    payload = await nav_response.json()
    wbi_img = ((payload.get("data") or {}).get("wbi_img") or {})
    img_key = _url_stem(str(wbi_img.get("img_url") or ""))
    sub_key = _url_stem(str(wbi_img.get("sub_url") or ""))
    mixin_key = _mixin_key(img_key, sub_key)

    signed = dict(params)
    signed["wts"] = int(time.time())
    filtered = {
        key: "".join(ch for ch in str(value) if ch not in "!'()*")
        for key, value in sorted(signed.items())
    }
    signed["w_rid"] = hashlib.md5((urlencode(filtered) + mixin_key).encode("utf-8")).hexdigest()
    return signed


def _url_stem(url: str) -> str:
    return PurePosixPath(urlparse(url).path).stem


def _mixin_key(img_key: str, sub_key: str) -> str:
    raw = img_key + sub_key
    return "".join(raw[index] for index in MIXIN_KEY_ENC_TAB if index < len(raw))[:32]
