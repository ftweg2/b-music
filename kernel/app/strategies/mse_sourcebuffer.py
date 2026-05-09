from __future__ import annotations

import base64
import hashlib
import time
from typing import Any

from app.artifact_manager import write_json_artifact
from app.bilibili.bvid import normalize_video_url, parse_bvid
from app.browser.context_manager import BrowserContextManager
from app.models import StrategyName
from app.security import sanitize_text
from app.strategies.browser_network import _trigger_player_load
from app.strategies.base import StrategyContext, StrategyResult


class MseSourceBufferStrategy:
    name = StrategyName.MSE_SOURCEBUFFER

    def supports(self, context: StrategyContext) -> bool:
        return parse_bvid(context.url) is not None

    async def run(self, context: StrategyContext) -> StrategyResult:
        started = time.perf_counter()
        context.job_dir.mkdir(parents=True, exist_ok=True)
        segments_dir = context.job_dir / "mse_segments"
        segments_dir.mkdir(parents=True, exist_ok=True)
        raw_path = context.job_dir / "raw.m4s"
        manager = BrowserContextManager(context.settings)
        managed = None
        segment_manifest: list[dict[str, object]] = []

        async def receive_segment(_source: object, payload: dict[str, object]) -> None:
            order = int(payload.get("order") or len(segment_manifest))
            data = base64.b64decode(str(payload.get("dataBase64") or ""))
            if not data:
                return
            segment_path = segments_dir / f"segment_{order:06d}.m4s"
            segment_path.write_bytes(data)
            segment_manifest.append(
                {
                    "name": segment_path.name,
                    "order": order,
                    "mimeType": str(payload.get("mimeType") or ""),
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )

        try:
            video_url = normalize_video_url(context.url)
            managed = await manager.open_context(context.profile_id, add_mse_hook=True)
            await managed.context.expose_binding("__biliCtfAudioSegment", receive_segment)
            page = await managed.context.new_page()
            media_probe = CdpMediaProbe()
            await media_probe.attach(page)
            await page.goto(
                video_url,
                wait_until="domcontentloaded",
                timeout=int(context.settings.request_timeout_seconds * 1000),
            )
            await _trigger_player_load(page)
            await _trigger_mse_player_load(page, context.settings.mse_playback_rate)
            await _wait_for_mse_activity(
                page,
                context.settings.mse_capture_ms,
                context.settings.mse_playback_rate,
            )
            mse_stats = await _mse_stats(page)
            page_diagnostics = await _page_media_diagnostics(page)
            cdp_media = media_probe.summary()

            if not segment_manifest:
                debug_info = {
                    "mse_stats": mse_stats,
                    "page_media": page_diagnostics,
                    "cdp_media": cdp_media,
                }
                if not mse_stats.get("sourceBuffers"):
                    failure_code = "MSE_PLAYER_NOT_INITIALIZED"
                    reason = "The page did not create any MediaSource SourceBuffer in this browser context"
                    if cdp_media.get("player_error_count"):
                        failure_code = "MSE_PLAYER_MEDIA_ERROR"
                        reason = "Chromium media pipeline reported errors before SourceBuffer capture started"
                    return StrategyResult.failed(
                        failure_code=failure_code,
                        reason=reason,
                        timings={"duration_ms": _elapsed_ms(started)},
                        sanitized_debug_info=debug_info,
                    )
                return StrategyResult.failed(
                    failure_code="MSE_AUDIO_SEGMENTS_EMPTY",
                    reason="No audio SourceBuffer appendBuffer segments were captured",
                    timings={"duration_ms": _elapsed_ms(started)},
                    sanitized_debug_info=debug_info,
                )

            ordered = sorted(segment_manifest, key=lambda item: int(item["order"]))
            with raw_path.open("wb") as output:
                for item in ordered:
                    output.write((segments_dir / str(item["name"])).read_bytes())

            write_json_artifact(
                context.job_dir,
                "mse_segments_manifest.json",
                {"segments": ordered},
                "mse_segments_manifest",
                self.name,
            )
            return StrategyResult.succeeded(
                reason="Captured audio SourceBuffer segments for active job page",
                selected_media={
                    "segment_count": len(ordered),
                    "mime_types": sorted({str(item["mimeType"]) for item in ordered}),
                },
                raw_artifacts=[raw_path, context.job_dir / "mse_segments_manifest.json"],
                timings={"duration_ms": _elapsed_ms(started)},
                sanitized_debug_info={
                    "segment_count": len(ordered),
                    "raw_size_bytes": raw_path.stat().st_size,
                    "capture_window_ms": context.settings.mse_capture_ms,
                    "playback_rate": context.settings.mse_playback_rate,
                    "mse_stats": mse_stats,
                    "page_media": page_diagnostics,
                    "cdp_media": cdp_media,
                },
            )
        except Exception as exc:
            return StrategyResult.failed(
                failure_code="MSE_SOURCEBUFFER_FAILED",
                reason=sanitize_text(exc),
                timings={"duration_ms": _elapsed_ms(started)},
            )
        finally:
            if managed is not None:
                await managed.close()


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


async def _mse_stats(page: object) -> dict[str, object]:
    try:
        stats = await page.evaluate("() => window.__BILI_CTF_AUDIO_MSE_STATS__ || null")
        return stats or {"installed": False}
    except Exception:
        return {"installed": False}


async def _wait_for_mse_activity(page: object, wait_ms: int, playback_rate: float) -> None:
    deadline = time.perf_counter() + (wait_ms / 1000)
    interval_ms = 1000
    next_trigger_at = time.perf_counter()
    while time.perf_counter() < deadline:
        await page.wait_for_timeout(interval_ms)
        now = time.perf_counter()
        if now >= next_trigger_at:
            await _keep_mse_media_playing(page, playback_rate)
            next_trigger_at = now + 4


async def _trigger_mse_player_load(page: object, playback_rate: float) -> None:
    try:
        await page.wait_for_selector("video", timeout=5000)
    except Exception:
        pass
    try:
        await page.evaluate(
            """
            async (rate) => {
              const candidates = [
                ".bpx-player-ctrl-play",
                ".bilibili-player-video-btn-start",
                ".bpx-player-video-wrap",
                ".bpx-player-container"
              ];
              for (const selector of candidates) {
                for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 3)) {
                  try { element.click(); } catch (_error) {}
                }
              }
              for (const video of Array.from(document.querySelectorAll("video")).slice(0, 3)) {
                try {
                  video.muted = true;
                  video.playbackRate = rate;
                  const playPromise = video.play();
                  if (playPromise && typeof playPromise.catch === "function") {
                    await playPromise.catch(() => {});
                  }
                } catch (_error) {}
              }
            }
            """,
            playback_rate,
        )
    except Exception:
        pass


async def _keep_mse_media_playing(page: object, playback_rate: float) -> None:
    try:
        await page.evaluate(
            """
            async (rate) => {
              for (const video of Array.from(document.querySelectorAll("video")).slice(0, 3)) {
                try {
                  video.muted = true;
                  video.playbackRate = rate;
                  if (video.paused || video.readyState < 3) {
                    const playPromise = video.play();
                    if (playPromise && typeof playPromise.catch === "function") {
                      await playPromise.catch(() => {});
                    }
                  }
                } catch (_error) {}
              }
            }
            """,
            playback_rate,
        )
    except Exception:
        pass


async def _page_media_diagnostics(page: object) -> dict[str, object]:
    try:
        diagnostics = await page.evaluate(
            """
            () => {
              const safeNumber = (value) => Number.isFinite(value) ? value : null;
              const videos = Array.from(document.querySelectorAll("video")).slice(0, 5).map((video) => {
                let currentSrcKind = "empty";
                try {
                  if (video.currentSrc) {
                    const parsed = new URL(video.currentSrc, location.href);
                    currentSrcKind = parsed.protocol === "blob:" ? "blob" : parsed.protocol.replace(":", "");
                  }
                } catch (_error) {
                  currentSrcKind = "unparseable";
                }
                return {
                  readyState: video.readyState,
                  networkState: video.networkState,
                  paused: video.paused,
                  muted: video.muted,
                  playbackRate: video.playbackRate,
                  duration: safeNumber(video.duration),
                  currentTime: safeNumber(video.currentTime),
                  hasCurrentSrc: Boolean(video.currentSrc),
                  currentSrcKind,
                  errorCode: video.error ? video.error.code : null,
                  errorMessage: video.error ? String(video.error.message || "").slice(0, 240) : null
                };
              });
              const mediaSource = window.MediaSource || null;
              return {
                documentReadyState: document.readyState,
                visibilityState: document.visibilityState,
                videoCount: videos.length,
                videos,
                mseGlobals: {
                  mediaSourceAvailable: typeof window.MediaSource === "function",
                  managedMediaSourceAvailable: typeof window.ManagedMediaSource === "function",
                  canConstructInDedicatedWorker: Boolean(
                    window.MediaSource && window.MediaSource.canConstructInDedicatedWorker
                  )
                },
                canPlayType: {
                  audioMp4: mediaSource ? MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"') : false,
                  videoMp4AvcAudio: mediaSource ? MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028, mp4a.40.2"') : false
                }
              };
            }
            """
        )
        return diagnostics or {}
    except Exception as exc:
        return {"error": sanitize_text(exc)}


class CdpMediaProbe:
    def __init__(self) -> None:
        self.available = False
        self.error: str | None = None
        self.players: list[dict[str, object]] = []
        self.player_events: list[dict[str, object]] = []
        self.player_messages: list[dict[str, object]] = []
        self.player_errors: list[dict[str, object]] = []
        self.player_properties: list[dict[str, object]] = []
        self.session: Any | None = None

    async def attach(self, page: object) -> None:
        try:
            self.session = await page.context.new_cdp_session(page)
            self.session.on("Media.playerCreated", self._on_player_created)
            self.session.on("Media.playerEventsAdded", self._on_player_events_added)
            self.session.on("Media.playerMessagesLogged", self._on_player_messages_logged)
            self.session.on("Media.playerErrorsRaised", self._on_player_errors_raised)
            self.session.on("Media.playerPropertiesChanged", self._on_player_properties_changed)
            await self.session.send("Media.enable")
            self.available = True
        except Exception as exc:
            self.error = sanitize_text(exc)

    def _on_player_created(self, params: dict[str, object]) -> None:
        player = params.get("player") or {}
        if isinstance(player, dict):
            self._append_limited(
                self.players,
                {
                    "playerId": sanitize_text(player.get("playerId")),
                    "domNodeId": player.get("domNodeId"),
                },
            )

    def _on_player_events_added(self, params: dict[str, object]) -> None:
        for event in _as_dict_list(params.get("events")):
            self._append_limited(
                self.player_events,
                {
                    "playerId": sanitize_text(params.get("playerId")),
                    "value": sanitize_text(event.get("value")),
                },
            )

    def _on_player_messages_logged(self, params: dict[str, object]) -> None:
        for message in _as_dict_list(params.get("messages")):
            self._append_limited(
                self.player_messages,
                {
                    "playerId": sanitize_text(params.get("playerId")),
                    "level": sanitize_text(message.get("level")),
                    "message": sanitize_text(message.get("message")),
                },
            )

    def _on_player_errors_raised(self, params: dict[str, object]) -> None:
        for error in _as_dict_list(params.get("errors")):
            self._append_limited(
                self.player_errors,
                {
                    "playerId": sanitize_text(params.get("playerId")),
                    "errorType": sanitize_text(error.get("errorType")),
                    "code": error.get("code"),
                    "data": _compact_jsonable(error.get("data")),
                },
            )

    def _on_player_properties_changed(self, params: dict[str, object]) -> None:
        for prop in _as_dict_list(params.get("properties")):
            name = sanitize_text(prop.get("name"))
            if name.lower() in {"url", "origin_url", "pipeline_state"}:
                value = "<redacted>" if name.lower() != "pipeline_state" else sanitize_text(prop.get("value"))
            else:
                value = sanitize_text(prop.get("value"))
            self._append_limited(
                self.player_properties,
                {
                    "playerId": sanitize_text(params.get("playerId")),
                    "name": name,
                    "value": value,
                },
            )

    def _append_limited(self, target: list[dict[str, object]], item: dict[str, object], limit: int = 25) -> None:
        if len(target) < limit:
            target.append(item)

    def summary(self) -> dict[str, object]:
        return {
            "available": self.available,
            "error": self.error,
            "player_count": len(self.players),
            "player_event_count": len(self.player_events),
            "player_message_count": len(self.player_messages),
            "player_error_count": len(self.player_errors),
            "players": self.players[:10],
            "recent_events": self.player_events[-10:],
            "recent_messages": self.player_messages[-10:],
            "errors": self.player_errors[-10:],
            "properties": self.player_properties[-15:],
        }


def _as_dict_list(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _compact_jsonable(value: object) -> object:
    if isinstance(value, dict):
        return {sanitize_text(key): _compact_jsonable(item) for key, item in list(value.items())[:12]}
    if isinstance(value, list):
        return [_compact_jsonable(item) for item in value[:12]]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return sanitize_text(value)
