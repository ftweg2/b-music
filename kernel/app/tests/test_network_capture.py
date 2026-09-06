import asyncio

from app.browser.network_capture import MediaCandidate, NetworkCapture, score_candidate


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


def test_bounded_ranking_matches_full_stable_sort_and_preserves_total_count():
    capture = NetworkCapture()
    original = []
    for index in range(20_000):
        candidate = MediaCandidate(
            actual_url=f"https://example.bilivideo.com/audio-{index}.m4s?token=synthetic",
            sanitized_url=f"https://example.bilivideo.com/audio-{index}.m4s",
            status=206, resource_type="media", content_type="audio/mp4", content_length=65536,
            score=float((index * 17) % 113), reasons=["audio_mp4_content_type"],
        )
        original.append(candidate)
        capture._remember(candidate)
    assert capture.best_candidate() is max(original, key=lambda candidate: candidate.score)
    assert capture.sanitized_candidates() == [
        candidate.sanitized_dict() for candidate in sorted(original, key=lambda candidate: candidate.score, reverse=True)[:10]
    ]
    assert capture.sanitized_summary()["candidate_count"] == len(original)
    assert len(capture._candidate_heap) == 10


def test_best_audio_is_not_lost_when_diagnostics_are_filled_with_contradictory_playurl_entries():
    capture = NetworkCapture()
    audio = MediaCandidate("https://example.bilivideo.com/audio.m4s", "", 200, "xhr", "audio/mp4", 0, 80, ["playurl_dash_audio"])
    capture._remember(audio)
    for index in range(100):
        capture._remember(MediaCandidate(f"https://example.bilivideo.com/video-{index}.m4s", "", 200, "xhr",
                                         "video/mp4", 0, 100, ["playurl_dash_audio"]))
    assert capture.best_candidate() is audio
    assert capture.sanitized_summary()["candidate_count"] == 101
    assert len(capture.sanitized_candidates()) == 10


def test_media_event_burst_does_not_create_one_task_per_response():
    async def run():
        page = FakePage()
        capture = NetworkCapture()
        capture.attach(page)
        for _ in range(10_000):
            page.handlers["response"](FakeResponse())
        assert len(capture._pending_tasks) == 0
        assert capture.sanitized_summary()["response_count"] == 10_000
        assert capture.sanitized_summary()["candidate_count"] == 10_000
        await capture.finish()
        assert "response" not in page.handlers
        assert capture.best_candidate().actual_url == FakeResponse.url
    asyncio.run(run())


def test_playurl_bodies_have_bounded_concurrency_and_finish_waits_for_every_candidate():
    async def run():
        active = maximum = 0
        release = asyncio.Event()
        class PlayurlResponse(FakeResponse):
            status = 200
            url = "https://api.bilibili.com/x/player/wbi/playurl"
            async def json(self):
                nonlocal active, maximum
                active += 1
                maximum = max(maximum, active)
                await release.wait()
                active -= 1
                return {"data": {"dash": {"audio": [{"baseUrl": FakeResponse.url, "bandwidth": 100_000}]}}}
        page = FakePage()
        capture = NetworkCapture()
        capture.attach(page)
        for _ in range(20):
            page.handlers["response"](PlayurlResponse())
        await asyncio.sleep(0)
        assert active == maximum == 4
        finishing = asyncio.create_task(capture.finish())
        await asyncio.sleep(0)
        assert not finishing.done()
        release.set()
        await finishing
        assert maximum == 4
        assert capture.sanitized_summary()["candidate_count"] == 20
        assert capture.sanitized_summary()["response_count"] == 20
        assert not capture._pending_tasks
    asyncio.run(run())
