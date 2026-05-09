from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass

from app.security import sanitize_url


@dataclass
class MediaCandidate:
    actual_url: str
    sanitized_url: str
    status: int
    resource_type: str
    content_type: str
    content_length: int
    score: float
    reasons: list[str]

    def sanitized_dict(self) -> dict[str, object]:
        data = asdict(self)
        data.pop("actual_url", None)
        if not data.get("sanitized_url"):
            data["sanitized_url"] = sanitize_url(self.actual_url) or "<redacted>"
        return data


def _content_length(headers: dict[str, str]) -> int:
    value = headers.get("content-length") or headers.get("Content-Length") or "0"
    try:
        return int(value)
    except ValueError:
        return 0


def score_candidate(
    url: str,
    status: int,
    resource_type: str,
    headers: dict[str, str],
    playurl_audio_hosts: set[str] | None = None,
) -> tuple[float, list[str]]:
    reasons: list[str] = []
    lower_url = url.lower()
    content_type = (headers.get("content-type") or headers.get("Content-Type") or "").lower()
    length = _content_length(headers)
    score = 0.0
    media_signal = False

    blocked_url_tokens = [
        "captcha",
        "security.bilibili.com",
        "/x/click-interface/",
        "/x/report/",
        "/x/web-interface/nav",
        "/reply/",
        "/history/",
        "heartbeat",
        "log",
    ]
    if any(token in lower_url for token in blocked_url_tokens):
        reasons.append("blocked_non_media_endpoint")
        return -100.0, reasons

    if status in {200, 206}:
        score += 10
        reasons.append("http_media_status")
    if "audio/mp4" in content_type:
        score += 30
        reasons.append("audio_mp4_content_type")
        media_signal = True
    elif "video/mp4" in content_type:
        score += 8
        reasons.append("mp4_content_type")
        media_signal = True
    elif "application/octet-stream" in content_type:
        score += 8
        reasons.append("octet_stream_content_type")
        media_signal = True
    elif "application/json" in content_type or "text/" in content_type:
        score -= 35
        reasons.append("structured_non_media_content_type")
    if "m4s" in lower_url or "m4a" in lower_url:
        score += 20
        reasons.append("media_extension")
        media_signal = True
    if resource_type in {"media", "xhr", "fetch"}:
        score += 8
        reasons.append("media_resource_type")
        if resource_type == "media":
            media_signal = True
    if "bilivideo.com" in lower_url or "bilibili.com" in lower_url:
        score += 15
        reasons.append("bilibili_media_host")
    if length > 64 * 1024:
        score += 5
        reasons.append("meaningful_content_length")
    if 0 < length < 8 * 1024:
        score -= 20
        reasons.append("too_small")
    if any(token in lower_url for token in [".jpg", ".png", ".webp", ".css", ".js"]):
        score -= 40
        reasons.append("static_asset")
    if any(token in lower_url for token in ["subtitle", "danmaku", "comment"]):
        score -= 30
        reasons.append("non_audio_sidecar")
    if playurl_audio_hosts and any(host in lower_url for host in playurl_audio_hosts):
        score += 15
        reasons.append("matches_playurl_audio_host")
        media_signal = True
    if not media_signal:
        score -= 50
        reasons.append("missing_media_signal")
    return score, reasons


class NetworkCapture:
    def __init__(self) -> None:
        self._candidates: list[MediaCandidate] = []
        self._response_count = 0
        self._rejected_reasons: dict[str, int] = {}

    def attach(self, page: object) -> None:
        page.on("response", lambda response: asyncio.create_task(self.record_response(response)))

    async def record_response(self, response: object) -> None:
        try:
            self._response_count += 1
            request = response.request
            headers = dict(response.headers)
            url = str(response.url)
            status = int(response.status)
            resource_type = str(request.resource_type)
            content_type = headers.get("content-type") or headers.get("Content-Type") or ""
            length = _content_length(headers)

            if status == 200 and "playurl" in url.lower():
                extracted = await self._record_playurl_candidates(response, resource_type)
                if extracted:
                    return

            score, reasons = score_candidate(url, status, resource_type, headers)
            if score <= 0:
                for reason in reasons:
                    self._rejected_reasons[reason] = self._rejected_reasons.get(reason, 0) + 1
                return
            self._candidates.append(
                MediaCandidate(
                    actual_url=url,
                    sanitized_url=sanitize_url(url) or "<redacted>",
                    status=status,
                    resource_type=resource_type,
                    content_type=content_type,
                    content_length=length,
                    score=score,
                    reasons=reasons,
                )
            )
        except Exception:
            return

    async def _record_playurl_candidates(self, response: object, resource_type: str) -> bool:
        try:
            payload = await response.json()
        except Exception:
            return False
        data = payload.get("data") if isinstance(payload, dict) else None
        dash = data.get("dash") if isinstance(data, dict) else None
        audio_items = dash.get("audio") if isinstance(dash, dict) else None
        if not isinstance(audio_items, list):
            return False

        found = False
        for item in audio_items:
            if not isinstance(item, dict):
                continue
            media_url = item.get("baseUrl") or item.get("base_url")
            if not media_url:
                continue
            bandwidth = int(item.get("bandwidth") or 0)
            score = 80.0 + min(bandwidth / 10000.0, 20.0)
            self._candidates.append(
                MediaCandidate(
                    actual_url=str(media_url),
                    sanitized_url=sanitize_url(str(media_url)) or "<redacted>",
                    status=int(response.status),
                    resource_type=resource_type,
                    content_type=str(item.get("mimeType") or item.get("mime_type") or "audio/mp4"),
                    content_length=0,
                    score=score,
                    reasons=["playurl_dash_audio"],
                )
            )
            found = True
        return found

    def best_candidate(self) -> MediaCandidate | None:
        if not self._candidates:
            return None
        return max(self._candidates, key=lambda candidate: candidate.score)

    def sanitized_candidates(self, limit: int = 10) -> list[dict[str, object]]:
        ordered = sorted(self._candidates, key=lambda candidate: candidate.score, reverse=True)
        return [candidate.sanitized_dict() for candidate in ordered[:limit]]

    def sanitized_summary(self) -> dict[str, object]:
        return {
            "response_count": self._response_count,
            "candidate_count": len(self._candidates),
            "rejected_reasons": dict(sorted(self._rejected_reasons.items())),
        }
