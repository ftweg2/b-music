from __future__ import annotations

import asyncio
import base64
import hashlib
from pathlib import Path
from threading import Event

from app.artifact_manager import write_json_artifact
from app.async_work import run_blocking
from app.strategies.base import StrategyCancelled, StrategyContext


class MseCaptureLimitExceeded(RuntimeError):
    pass


class MseSegmentSequenceInvalid(RuntimeError):
    pass


class MseSegmentSink:
    """One decoded segment/IO worker at a time; retain only manifest metadata.

    Reservation happens before waiting, so concurrent binding callbacks cannot
    evade the existing total-size/count limits. The browser also checks these
    limits before encoding; neither side silently drops successful audio.
    """

    def __init__(self, context: StrategyContext, directory: Path):
        self.context = context
        self.directory = directory
        self.manifest: list[dict[str, object]] = []
        self.captured_bytes = 0
        self._reserved_bytes = 0
        self._orders: set[int] = set()
        self._writer = asyncio.Lock()
        self._pending: set[asyncio.Task] = set()
        self._failure: Exception | None = None
        self._accepting = True
        self._stop = Event()

    def check_error(self) -> None:
        self.context.raise_if_cancelled()
        if self._failure is not None:
            raise self._failure

    def _check_stop(self, stop: Event) -> None:
        if stop.is_set() or self._stop.is_set():
            raise StrategyCancelled("MSE capture cancelled")
        self.context.raise_if_cancelled()

    async def receive(self, _source: object, payload: dict[str, object]) -> None:
        if not self._accepting:
            return
        task = asyncio.current_task()
        self._pending.add(task)
        try:
            self.check_error()
            encoded = payload.get("dataBase64")
            if not isinstance(encoded, str):
                raise ValueError("MSE segment payload must contain Base64 text")
            if not encoded:
                return
            settings = self.context.settings
            if len(encoded) > 4 * ((settings.mse_max_segment_bytes + 2) // 3):
                raise MseCaptureLimitExceeded("MSE segment exceeded capture size limit")
            if len(encoded) % 4:
                raise ValueError("MSE segment Base64 length is invalid")
            size = (len(encoded) // 4) * 3 - (2 if encoded.endswith("==") else 1 if encoded.endswith("=") else 0)
            if size > settings.mse_max_segment_bytes:
                raise MseCaptureLimitExceeded("MSE segment exceeded capture size limit")
            if len(self._orders) >= settings.mse_max_segments:
                raise MseCaptureLimitExceeded("MSE segment count exceeded capture limit")
            if self._reserved_bytes + size > settings.mse_max_capture_bytes:
                raise MseCaptureLimitExceeded("MSE capture exceeded total size limit")
            order = payload.get("order", len(self._orders))
            if type(order) is not int or not 0 <= order < settings.mse_max_segments or order in self._orders:
                raise MseSegmentSequenceInvalid("Captured MSE segment sequence contained a gap or duplicate")
            declared_size = payload.get("size", size)
            if type(declared_size) is not int or declared_size != size:
                raise ValueError("MSE segment declared size does not match its payload")
            self._orders.add(order)
            self._reserved_bytes += size
            mime_type = str(payload.get("mimeType") or "")
            async with self._writer:
                self.check_error()
                item = await run_blocking(lambda stop: self._write(encoded, size, order, mime_type, stop))
                self.manifest.append(item)
                self.captured_bytes += size
        except asyncio.CancelledError:
            if self._failure is None:
                self._failure = StrategyCancelled("MSE segment delivery cancelled")
            raise
        except Exception as exc:
            if self._failure is None:
                self._failure = exc
            raise
        finally:
            self._pending.discard(task)

    def _write(self, encoded: str, size: int, order: int, mime_type: str, stop: Event) -> dict[str, object]:
        self._check_stop(stop)
        data = base64.b64decode(encoded, validate=True)
        if len(data) != size:
            raise ValueError("MSE segment decoded size is invalid")
        self._check_stop(stop)
        target = self.directory / f"segment_{order:06d}.m4s"
        temporary = target.with_suffix(".tmp")
        try:
            temporary.write_bytes(data)
            checksum = hashlib.sha256(data).hexdigest()
            self._check_stop(stop)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
        return {"name": target.name, "order": order, "mimeType": mime_type, "size": size, "sha256": checksum}

    async def finish(self, raw_path: Path, strategy: str) -> list[dict[str, object]]:
        self._accepting = False
        await self._drain()
        self.check_error()
        ordered = sorted(self.manifest, key=lambda item: int(item["order"]))
        if len(ordered) != len(self._orders) or any(item["order"] != index for index, item in enumerate(ordered)):
            raise MseSegmentSequenceInvalid("Captured MSE segment sequence contained a gap or duplicate")
        if ordered:
            await run_blocking(lambda stop: self._merge(raw_path, ordered, strategy, stop))
        return ordered

    def _merge(self, raw_path: Path, ordered: list[dict[str, object]], strategy: str, stop: Event) -> None:
        temporary = raw_path.with_name(f".{raw_path.name}.merge")
        try:
            with temporary.open("wb") as output:
                for item in ordered:
                    self._check_stop(stop)
                    with (self.directory / str(item["name"])).open("rb") as segment:
                        while chunk := segment.read(1024 * 1024):
                            self._check_stop(stop)
                            output.write(chunk)
            self._check_stop(stop)
            temporary.replace(raw_path)
            write_json_artifact(self.context.job_dir, "mse_segments_manifest.json", {"segments": ordered},
                                "mse_segments_manifest", strategy)
        finally:
            temporary.unlink(missing_ok=True)

    async def _drain(self) -> None:
        if not self._pending:
            return
        pending = asyncio.gather(*tuple(self._pending), return_exceptions=True)
        try:
            await asyncio.shield(pending)
        except asyncio.CancelledError:
            self._stop.set()
            while not pending.done():
                try:
                    await asyncio.shield(pending)
                except asyncio.CancelledError:
                    pass
            raise

    async def close(self) -> None:
        self._accepting = False
        self._stop.set()
        await self._drain()
