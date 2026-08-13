import asyncio
from collections.abc import AsyncIterator

import httpx
import pytest

from app.strategies.api_dash import (
    _build_ranges,
    _download_sequential,
    _parse_content_range,
    _parse_content_range_total,
)
from app.strategies.base import StrategyCancelled


class ByteStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            yield chunk


def test_parse_content_range_total() -> None:
    assert _parse_content_range_total("bytes 0-0/12345") == 12345
    assert _parse_content_range_total("bytes 0-0/*") is None
    assert _parse_content_range_total("invalid") is None
    assert _parse_content_range("bytes 1-4/10") == (1, 4, 10)
    assert _parse_content_range("bytes 1-10/10") is None


def test_build_ranges_respects_concurrency_and_order() -> None:
    ranges = _build_ranges(content_length=10, concurrency=3, min_parallel_bytes=1)

    assert ranges == [(0, 3), (4, 7), (8, 9)]


def test_build_ranges_avoids_parallel_for_small_files() -> None:
    ranges = _build_ranges(content_length=1024, concurrency=4, min_parallel_bytes=4096)

    assert ranges == [(0, 1023)]


def test_sequential_download_rejects_truncated_response_without_publishing(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-length": "8"},
            stream=ByteStream([b"short"]),
        )

    async def run() -> None:
        output_path = tmp_path / "raw.m4s"
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(httpx.HTTPError):
                await _download_sequential(client, "https://example.test/audio", {}, output_path)

        assert not output_path.exists()
        assert not (tmp_path / ".raw.m4s.download").exists()

    asyncio.run(run())


def test_sequential_download_cancellation_removes_partial_file(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=ByteStream([b"audio-bytes"]))

    async def run() -> None:
        output_path = tmp_path / "raw.m4s"
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(StrategyCancelled):
                await _download_sequential(
                    client,
                    "https://example.test/audio",
                    {},
                    output_path,
                    lambda: True,
                )

        assert not output_path.exists()

    asyncio.run(run())


def test_sequential_download_accepts_stream_without_content_length(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=ByteStream([b"audio", b"-bytes"]))

    async def run() -> None:
        output_path = tmp_path / "raw.m4s"
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await _download_sequential(client, "https://example.test/audio", {}, output_path)
        assert output_path.read_bytes() == b"audio-bytes"

    asyncio.run(run())


def test_sequential_download_rejects_nonzero_partial_range(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            206,
            headers={"content-range": "bytes 5-9/10", "content-length": "5"},
            stream=ByteStream([b"audio"]),
        )

    async def run() -> None:
        output_path = tmp_path / "raw.m4s"
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(httpx.HTTPError):
                await _download_sequential(client, "https://example.test/audio", {}, output_path)
        assert not output_path.exists()

    asyncio.run(run())
