from __future__ import annotations

import hashlib
import time
from pathlib import PurePosixPath
from urllib.parse import urlencode, urlparse

from app.bilibili.bvid import normalize_video_url, parse_bvid
from app.bilibili.playurl import select_best_audio
from app.bilibili.wbi import MIXIN_KEY_ENC_TAB
from app.browser.context_manager import BrowserContextManager
from app.browser.network_capture import MediaCandidate, NetworkCapture
from app.models import StrategyName
from app.security import sanitize_text
from app.strategies.base import StrategyContext, StrategyResult


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
            await page.wait_for_timeout(context.settings.network_capture_ms)

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

            response = await managed.context.request.get(
                candidate.actual_url,
                headers={
                    "referer": video_url,
                    "user-agent": context.settings.bilibili_user_agent,
                },
                timeout=int(context.settings.request_timeout_seconds * 1000),
            )
            if response.status not in {200, 206}:
                return StrategyResult.failed(
                    failure_code="AUDIO_DOWNLOAD_FAILED",
                    reason=f"captured media download HTTP {response.status}",
                    timings={"duration_ms": _elapsed_ms(started)},
                    sanitized_debug_info={
                        "capture": capture.sanitized_summary(),
                        "candidate": candidate.sanitized_dict(),
                    },
                )
            body = await response.body()
            if not body:
                return StrategyResult.failed(
                    failure_code="AUDIO_DOWNLOAD_FAILED",
                    reason="captured media response body was empty",
                    timings={"duration_ms": _elapsed_ms(started)},
                    sanitized_debug_info={
                        "capture": capture.sanitized_summary(),
                        "candidate": candidate.sanitized_dict(),
                    },
                )
            raw_path.write_bytes(body)

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
        except Exception as exc:
            return StrategyResult.failed(
                failure_code="BROWSER_NETWORK_FAILED",
                reason=sanitize_text(exc),
                timings={"duration_ms": _elapsed_ms(started)},
            )
        finally:
            if managed is not None:
                await managed.close()


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


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
