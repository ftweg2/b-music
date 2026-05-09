from app.strategies.api_dash import _build_ranges, _parse_content_range_total


def test_parse_content_range_total() -> None:
    assert _parse_content_range_total("bytes 0-0/12345") == 12345
    assert _parse_content_range_total("bytes 0-0/*") is None
    assert _parse_content_range_total("invalid") is None


def test_build_ranges_respects_concurrency_and_order() -> None:
    ranges = _build_ranges(content_length=10, concurrency=3, min_parallel_bytes=1)

    assert ranges == [(0, 3), (4, 7), (8, 9)]


def test_build_ranges_avoids_parallel_for_small_files() -> None:
    ranges = _build_ranges(content_length=1024, concurrency=4, min_parallel_bytes=4096)

    assert ranges == [(0, 1023)]
