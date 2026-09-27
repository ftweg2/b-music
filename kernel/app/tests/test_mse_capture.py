import asyncio
import base64
import hashlib
import json
from dataclasses import replace
from threading import Event, get_ident

import pytest

from app.async_work import run_blocking
from app.browser.mse_capture import MseCaptureLimitExceeded, MseSegmentSequenceInvalid, MseSegmentSink
from app.config import get_settings
from app.strategies.base import StrategyCancelled, StrategyContext


def make_sink(tmp_path, **settings):
    directory = tmp_path / "segments"
    directory.mkdir()
    context = StrategyContext(job_id="test", external_owner_id="owner", profile_id="p_test",
                              url="BV1GJ411x7h7", outputs=["raw"], job_dir=tmp_path, logged_in=False,
                              settings=replace(get_settings(), **settings))
    return MseSegmentSink(context, directory)


def payload(data, order=0):
    return {"order": order, "size": len(data), "mimeType": "audio/mp4", "dataBase64": base64.b64encode(data).decode()}


def test_parallel_deliveries_preserve_all_bytes_order_and_manifest(tmp_path):
    async def run():
        sink = make_sink(tmp_path)
        pieces = [bytes(range(256)) * (index + 1) for index in range(12)]
        await asyncio.gather(*(sink.receive(None, payload(pieces[index], index)) for index in reversed(range(12))))
        ordered = await sink.finish(tmp_path / "raw.m4s", "mse_sourcebuffer")
        assert (tmp_path / "raw.m4s").read_bytes() == b"".join(pieces)
        assert ordered == [{"name": f"segment_{index:06d}.m4s", "order": index, "mimeType": "audio/mp4",
                            "size": len(piece), "sha256": hashlib.sha256(piece).hexdigest()}
                           for index, piece in enumerate(pieces)]
        assert json.loads((tmp_path / "mse_segments_manifest.json").read_text()) == {"segments": ordered}
        assert sink.captured_bytes == sum(map(len, pieces))
        await sink.close()
    asyncio.run(run())


@pytest.mark.parametrize("settings,segments", [
    ({"mse_max_segment_bytes": 3}, [b"1234"]),
    ({"mse_max_capture_bytes": 5}, [b"123", b"456"]),
    ({"mse_max_segments": 1}, [b"1", b"2"]),
])
def test_limits_are_reserved_before_concurrent_writes(tmp_path, settings, segments):
    async def run():
        sink = make_sink(tmp_path, **settings)
        results = await asyncio.gather(*(sink.receive(None, payload(data, index)) for index, data in enumerate(segments)),
                                       return_exceptions=True)
        assert any(isinstance(result, MseCaptureLimitExceeded) for result in results)
        with pytest.raises(MseCaptureLimitExceeded):
            await sink.finish(tmp_path / "raw.m4s", "mse_sourcebuffer")
        assert not (tmp_path / "raw.m4s").exists()
        await sink.close()
    asyncio.run(run())


def test_oversized_segment_is_rejected_before_decode_allocation(tmp_path, monkeypatch):
    async def run():
        sink = make_sink(tmp_path, mse_max_segment_bytes=3)
        def forbidden(*_args, **_kwargs):
            raise AssertionError("oversized input must never be decoded")
        monkeypatch.setattr("app.browser.mse_capture.base64.b64decode", forbidden)
        with pytest.raises(MseCaptureLimitExceeded):
            await sink.receive(None, {"dataBase64": "A" * 1_000_000, "order": 0})
        await sink.close()
    asyncio.run(run())


@pytest.mark.parametrize("bad", [
    {"dataBase64": "!!!!", "order": 0},
    {"dataBase64": "YQ=", "order": 0},
    {"dataBase64": "YQ==", "order": 0, "size": 2},
    {"dataBase64": "YQ==", "order": -1},
    {"dataBase64": "YQ==", "order": "0"},
])
def test_invalid_segments_never_publish_partial_audio(tmp_path, bad):
    async def run():
        sink = make_sink(tmp_path)
        with pytest.raises((ValueError, MseSegmentSequenceInvalid)):
            await sink.receive(None, bad)
        with pytest.raises((ValueError, MseSegmentSequenceInvalid)):
            await sink.finish(tmp_path / "raw.m4s", "mse_sourcebuffer")
        assert not (tmp_path / "raw.m4s").exists()
        await sink.close()
    asyncio.run(run())


@pytest.mark.parametrize("orders", [[0, 0], [1], [0, 2]])
def test_duplicate_and_missing_orders_fail(tmp_path, orders):
    async def run():
        sink = make_sink(tmp_path)
        await asyncio.gather(*(sink.receive(None, payload(b"audio", order)) for order in orders), return_exceptions=True)
        with pytest.raises(MseSegmentSequenceInvalid):
            await sink.finish(tmp_path / "raw.m4s", "mse_sourcebuffer")
        assert not (tmp_path / "raw.m4s").exists()
        await sink.close()
    asyncio.run(run())


def test_slow_writer_does_not_block_event_loop_and_only_one_decoder_runs(tmp_path, monkeypatch):
    async def run():
        sink = make_sink(tmp_path)
        started, release = Event(), Event()
        original = sink._write
        thread_ids = []
        loop_thread = get_ident()
        def slow(*args):
            thread_ids.append(get_ident())
            started.set()
            assert release.wait(3)
            return original(*args)
        monkeypatch.setattr(sink, "_write", slow)
        tasks = [asyncio.create_task(sink.receive(None, payload(b"abc", order))) for order in range(3)]
        try:
            assert await asyncio.to_thread(started.wait, 2)
            await asyncio.sleep(0.01)
            assert len(thread_ids) == 1
            assert thread_ids[0] != loop_thread
            assert not any(task.done() for task in tasks)
        finally:
            release.set()
        await asyncio.gather(*tasks)
        await sink.finish(tmp_path / "raw.m4s", "mse_sourcebuffer")
        await sink.close()
    asyncio.run(run())


def test_cancel_drains_worker_and_cannot_publish_late_data(tmp_path, monkeypatch):
    async def run():
        sink = make_sink(tmp_path)
        started, release, finished = Event(), Event(), Event()
        original = sink._write
        def slow(*args):
            started.set()
            assert release.wait(3)
            try:
                return original(*args)
            finally:
                finished.set()
        monkeypatch.setattr(sink, "_write", slow)
        task = asyncio.create_task(sink.receive(None, payload(b"original audio")))
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()
        with pytest.raises(StrategyCancelled):
            await sink.finish(tmp_path / "raw.m4s", "mse_sourcebuffer")
        assert not list(sink.directory.iterdir())
        assert not (tmp_path / "raw.m4s").exists()
        await sink.close()
    asyncio.run(run())


def test_empty_capture_does_not_create_empty_artifacts(tmp_path):
    async def run():
        sink = make_sink(tmp_path)
        await sink.receive(None, payload(b""))
        assert await sink.finish(tmp_path / "raw.m4s", "mse_sourcebuffer") == []
        assert not (tmp_path / "raw.m4s").exists()
        await sink.close()
    asyncio.run(run())


def test_blocking_worker_propagates_normal_errors():
    def fail(_stop):
        raise OSError("write failed")
    with pytest.raises(OSError, match="write failed"):
        asyncio.run(run_blocking(fail))
