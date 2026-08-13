from __future__ import annotations

import asyncio
import contextlib
import re
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


# Bilibili's DASH URLs commonly encode the representation id as the final
# numeric component of the ``.m4s`` path.  Audio representations use the
# 302xx range while video representations (including AV1) use 1000xx ids.
# Keep these checks deliberately narrow: a generic ``media`` request is not
# enough evidence that downloading it will produce an audio-only artifact.
_AUDIO_TRACK_ID_RE = re.compile(r"(?<!\d)302\d{2}(?!\d)")
_VIDEO_TRACK_ID_RE = re.compile(r"(?<!\d)100\d{3}(?!\d)")
_VIDEO_CODEC_RE = re.compile(
    r"(?<![a-z0-9])(?:av01?|avc1|h(?:26[45])|hev1|hvc1|vp0?[89]|vp09)"
    r"(?:[.\-_]|$)",
    re.IGNORECASE,
)
_AUDIO_CODEC_RE = re.compile(
    r"(?<![a-z0-9])(?:mp4a|aac|opus|vorbis|flac|ac-3|ec-3)(?:[.\-_]|$)",
    re.IGNORECASE,
)
_VIDEO_URL_RE = re.compile(r"(?<![a-z])video(?:[./_?=&-]|$)", re.IGNORECASE)
_AUDIO_URL_RE = re.compile(
    r"(?<![a-z])(?:audio|m4a|aac|opus|vorbis|flac)(?:[./_?=&-]|$)",
    re.IGNORECASE,
)


def _media_kind(
    url: str,
    content_type: str,
    *,
    reasons: list[str] | None = None,
    playurl_audio_hosts: set[str] | None = None,
) -> str:
    """Classify a captured response as audio, video, or unknown.

    Browser network responses often use ``application/octet-stream`` for both
    DASH audio and video segments.  In that case we only classify the
    candidate as audio when the URL carries an audio signal (or it came from
    the explicitly audio-only DASH list).  Video signals always win when a
    response contains contradictory metadata.
    """

    lower_url = url.lower()
    lower_content_type = content_type.lower()
    combined = f"{lower_url} {lower_content_type}"

    if lower_content_type.startswith("video/") or _VIDEO_CODEC_RE.search(combined):
        return "video"

    # Track ids and path markers are checked before audio hints so a
    # contradictory response (for example, an incorrectly labelled
    # ``audio/mp4`` video URL) is still rejected as video.
    if _VIDEO_TRACK_ID_RE.search(lower_url) or _VIDEO_URL_RE.search(lower_url):
        return "video"

    if playurl_audio_hosts and any(
        host.lower() in lower_url for host in playurl_audio_hosts if host
    ):
        return "audio"

    if (
        lower_content_type.startswith("audio/")
        or _AUDIO_TRACK_ID_RE.search(lower_url)
        or _AUDIO_CODEC_RE.search(combined)
        or _AUDIO_URL_RE.search(lower_url)
        or (reasons and "playurl_dash_audio" in reasons)
        or (reasons and "browser_context_playurl_dash_audio" in reasons)
    ):
        return "audio"
    return "unknown"


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

    media_kind = _media_kind(
        url,
        content_type,
        playurl_audio_hosts=playurl_audio_hosts,
    )
    if media_kind == "video":
        # A video response can carry a stronger generic media score than an
        # audio response (for example, a large AV1 segment).  Reject it
        # before scoring so it can never become the selected audio candidate.
        reasons.append("video_track")
        return -100.0, reasons

    if status in {200, 206}:
        score += 10
        reasons.append("http_media_status")
    if "audio/mp4" in content_type:
        score += 30
        reasons.append("audio_mp4_content_type")
        media_signal = True
    elif "application/octet-stream" in content_type:
        score += 8
        reasons.append("octet_stream_content_type")
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
    if media_kind != "audio":
        # ``application/octet-stream`` and generic ``.m4s`` URLs are used for
        # both DASH tracks.  Require an explicit audio signal before retaining
        # a candidate; otherwise a high-bandwidth video segment could win.
        score -= 100
        reasons.append("missing_audio_signal")
    return score, reasons


class NetworkCapture:
    def __init__(self) -> None:
        self._candidates: list[MediaCandidate] = []
        self._response_count = 0
        self._rejected_reasons: dict[str, int] = {}
        self._pending_tasks: set[asyncio.Task[None]] = set()
        self._attached_page: object | None = None
        self._response_handler: object | None = None

    def attach(self, page: object) -> None:
        def on_response(response: object) -> None:
            task = asyncio.create_task(self.record_response(response))
            self._pending_tasks.add(task)
            task.add_done_callback(self._pending_tasks.discard)

        self._attached_page = page
        self._response_handler = on_response
        page.on("response", on_response)

    async def finish(self) -> None:
        """Detach the listener and drain in-flight response handlers before selecting."""
        if self._attached_page is not None and self._response_handler is not None:
            remove_listener = getattr(self._attached_page, "remove_listener", None)
            if callable(remove_listener):
                with contextlib.suppress(Exception):
                    remove_listener("response", self._response_handler)
        pending = list(self._pending_tasks)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._pending_tasks.clear()
        self._attached_page = None
        self._response_handler = None

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
        audio_candidates = [
            candidate
            for candidate in self._candidates
            if _media_kind(
                candidate.actual_url,
                candidate.content_type,
                reasons=candidate.reasons,
            )
            == "audio"
        ]
        if not audio_candidates:
            return None
        return max(audio_candidates, key=lambda candidate: candidate.score)

    def sanitized_candidates(self, limit: int = 10) -> list[dict[str, object]]:
        ordered = sorted(self._candidates, key=lambda candidate: candidate.score, reverse=True)
        return [candidate.sanitized_dict() for candidate in ordered[:limit]]

    def sanitized_summary(self) -> dict[str, object]:
        return {
            "response_count": self._response_count,
            "candidate_count": len(self._candidates),
            "rejected_reasons": dict(sorted(self._rejected_reasons.items())),
        }
