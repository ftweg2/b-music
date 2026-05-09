from __future__ import annotations

from dataclasses import dataclass

import httpx

from .metadata import BilibiliApiError, VideoMetadata
from .wbi import sign_wbi_params


@dataclass(frozen=True)
class AudioCandidate:
    url: str
    bandwidth: int
    codecs: str | None
    mime_type: str | None
    audio_id: int | None


async def fetch_playurl(
    client: httpx.AsyncClient,
    metadata: VideoMetadata,
    user_agent: str,
) -> dict[str, object]:
    params = {
        "avid": metadata.aid,
        "bvid": metadata.bvid,
        "cid": metadata.cid,
        "qn": 127,
        "fnval": 16,
        "fourk": 1,
    }
    signed = await sign_wbi_params(client, params, user_agent)
    response = await client.get(
        "https://api.bilibili.com/x/player/wbi/playurl",
        params=signed,
        headers={
            "user-agent": user_agent,
            "referer": f"https://www.bilibili.com/video/{metadata.bvid}",
        },
    )
    if response.status_code == 403:
        raise BilibiliApiError("PLAYURL_HTTP_403", "playurl HTTP 403")
    if response.status_code == 412:
        raise BilibiliApiError("PLAYURL_HTTP_412", "playurl HTTP 412")
    if response.status_code != 200:
        raise BilibiliApiError("PLAYURL_CODE_NOT_ZERO", f"playurl HTTP {response.status_code}")
    payload = response.json()
    if payload.get("code") != 0:
        raise BilibiliApiError("PLAYURL_CODE_NOT_ZERO", f"playurl code {payload.get('code')}")
    return payload.get("data") or {}


def select_best_audio(playurl_data: dict[str, object]) -> AudioCandidate:
    dash = playurl_data.get("dash") if isinstance(playurl_data, dict) else None
    audio_items = (dash or {}).get("audio") if isinstance(dash, dict) else None
    if not audio_items:
        raise BilibiliApiError("DASH_AUDIO_EMPTY", "playurl dash.audio is empty")

    best = max(audio_items, key=lambda item: int(item.get("bandwidth") or 0))
    url = best.get("baseUrl") or best.get("base_url")
    if not url:
        raise BilibiliApiError("DASH_AUDIO_EMPTY", "selected audio missing URL")
    return AudioCandidate(
        url=str(url),
        bandwidth=int(best.get("bandwidth") or 0),
        codecs=best.get("codecs"),
        mime_type=best.get("mimeType") or best.get("mime_type"),
        audio_id=best.get("id"),
    )
