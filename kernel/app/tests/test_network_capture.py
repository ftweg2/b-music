import asyncio

from app.browser.network_capture import NetworkCapture, score_candidate


class FakePage:
    def __init__(self) -> None:
        self.handlers: dict[str, object] = {}

    def on(self, event: str, handler: object) -> None:
        self.handlers[event] = handler

    def remove_listener(self, event: str, handler: object) -> None:
        if self.handlers.get(event) is handler:
            self.handlers.pop(event)


class FakeRequest:
    resource_type = "media"


class FakeResponse:
    request = FakeRequest()
    headers = {"content-type": "audio/mp4", "content-length": "65536"}
    url = "https://example.bilivideo.com/audio.m4s?token=fake"
    status = 206


class FakeVideoRequest:
    resource_type = "xhr"


class FakeVideoResponse:
    request = FakeVideoRequest()
    headers = {"content-type": "application/octet-stream", "content-length": "10485760"}
    url = (
        "https://upos-sz-estgoss.bilivideo.com/upgcxcode/22/05/35822240522/"
        "35822240522-1-100024.m4s?token=fake"
    )
    status = 206


def test_finish_drains_handlers_and_detaches_listener() -> None:
    async def run() -> None:
        page = FakePage()
        capture = NetworkCapture()
        capture.attach(page)

        page.handlers["response"](FakeResponse())
        await asyncio.sleep(0)
        await capture.finish()

        assert "response" not in page.handlers
        assert capture.best_candidate() is not None
        assert capture.sanitized_summary()["candidate_count"] == 1

    asyncio.run(run())


def test_network_scoring_rejects_av1_video_track_even_with_media_signals() -> None:
    score, reasons = score_candidate(
        FakeVideoResponse.url,
        FakeVideoResponse.status,
        FakeVideoResponse.request.resource_type,
        {
            **FakeVideoResponse.headers,
            "content-type": "video/mp4; codecs=\"av01.0.08M.08\"",
        },
    )

    assert score < 0
    assert "video_track" in reasons


def test_best_candidate_never_selects_generic_video_track_over_audio() -> None:
    async def run() -> None:
        capture = NetworkCapture()
        await capture.record_response(FakeVideoResponse())
        await capture.record_response(FakeResponse())

        candidate = capture.best_candidate()
        assert candidate is not None
        assert candidate.actual_url == FakeResponse.url
        assert "video_track" not in candidate.reasons
        assert capture.sanitized_summary()["candidate_count"] == 1
        assert capture.sanitized_summary()["rejected_reasons"]["video_track"] == 1

    asyncio.run(run())


def test_network_scoring_rejects_unclassified_octet_stream_m4s() -> None:
    score, reasons = score_candidate(
        "https://upos-sz-estgoss.bilivideo.com/upgcxcode/22/05/35822240522/"
        "35822240522-1-999999.m4s",
        206,
        "xhr",
        {"content-type": "application/octet-stream", "content-length": "10485760"},
    )

    assert score < 0
    assert "missing_audio_signal" in reasons
