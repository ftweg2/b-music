import asyncio
from dataclasses import replace

import httpx
import pytest

from app.config import get_settings
from app.douyin.detail import DouyinAweme, DouyinMusic, DouyinUnavailable
from app.strategies import douyin_music
from app.strategies.base import StrategyCancelled, StrategyContext
from app.strategies.douyin_music import DouyinMusicStrategy


AWEME_ID = "7687946506598968422"
MUSIC_URLS = [
    "https://lf3-music-east.douyinstatic.com/obj/ies-music-hj/1.mp3",
    "https://lf26-music-east.douyinstatic.com/obj/ies-music-hj/1.mp3",
]
VIDEO_URL = "https://v5-hl-mly-ov.zjcdn.com/sig/video/tos/cn/video.mp4?x-signature=secret"
FAKE_MP4 = b"\x00\x00\x00\x18ftypmp42video-bytes"


def make_context(tmp_path, url=f"https://www.douyin.com/video/{AWEME_ID}", cancel=None) -> StrategyContext:
    return StrategyContext(
        job_id="job_douyin",
        external_owner_id="owner",
        profile_id="p_123456789012",
        url=url,
        outputs=["raw"],
        job_dir=tmp_path / "job_douyin",
        settings=replace(get_settings(), data_dir=tmp_path),
        logged_in=False,
        cancel_requested=cancel,
    )


def make_aweme(music_urls=MUSIC_URLS, video_urls=(VIDEO_URL,)) -> DouyinAweme:
    return DouyinAweme(
        aweme_id=AWEME_ID,
        desc="一首歌 #音乐",
        author="作者",
        duration_seconds=84,
        music=DouyinMusic(title="歌名", author="歌手", duration_seconds=83, play_urls=list(music_urls)),
        video_play_urls=list(video_urls),
    )


def use_detail(monkeypatch, aweme: DouyinAweme) -> list[str]:
    calls: list[str] = []

    async def fake_fetch(aweme_id, _settings, _raise_if_cancelled=None):
        calls.append(aweme_id)
        return aweme

    monkeypatch.setattr(douyin_music, "fetch_aweme_detail", fake_fetch)
    return calls


def use_download(monkeypatch, fail_urls=()) -> list[str]:
    attempted: list[str] = []

    async def fake_download(_client, url, headers, output_path, settings, _cancel=None, **limits):
        attempted.append(url)
        assert headers["referer"] == "https://www.douyin.com/"
        assert "cookie" not in {key.lower() for key in headers}
        assert limits == {
            "concurrency": settings.douyin_download_concurrency,
            "min_parallel_bytes": douyin_music.PARALLEL_PART_MIN_BYTES,
            "max_bytes": settings.douyin_max_download_bytes,
        }
        if url in fail_urls:
            raise httpx.ConnectError("mirror unavailable")
        output_path.write_bytes(b"ID3-audio" if output_path.suffix == ".mp3" else FAKE_MP4)
        return {"mode": "single_stream", "chunks": 1, "content_length": output_path.stat().st_size}

    monkeypatch.setattr(douyin_music, "download_audio", fake_download)
    return attempted


def test_supports_only_douyin_links(tmp_path) -> None:
    strategy = DouyinMusicStrategy()

    assert strategy.supports(make_context(tmp_path))
    assert strategy.supports(make_context(tmp_path, url="https://v.douyin.com/iRNBho6x/"))
    assert not strategy.supports(make_context(tmp_path, url="https://www.bilibili.com/video/BV1GJ411x7h7"))
    assert not strategy.supports(make_context(tmp_path, url="https://www.douyin.com/"))


def test_background_music_is_kept_as_published(tmp_path, monkeypatch) -> None:
    detail_calls = use_detail(monkeypatch, make_aweme())
    attempted = use_download(monkeypatch)

    result = asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path)))

    assert result.status == "succeeded", result.reason
    assert detail_calls == [AWEME_ID]
    assert attempted == MUSIC_URLS[:1]
    assert [path.name for path in result.raw_artifacts] == ["raw.mp3"]
    assert result.raw_artifacts[0].read_bytes() == b"ID3-audio"
    assert result.selected_media == {
        "source": "douyin",
        "aweme_id": AWEME_ID,
        "media_kind": "music",
        "media_host": "lf3-music-east.douyinstatic.com",
        "music_title": "歌名",
        "music_author": "歌手",
    }
    assert result.sanitized_debug_info["title"] == "一首歌 #音乐"


def test_next_mirror_is_tried_when_one_fails(tmp_path, monkeypatch) -> None:
    use_detail(monkeypatch, make_aweme())
    attempted = use_download(monkeypatch, fail_urls={MUSIC_URLS[0]})

    result = asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path)))

    assert result.status == "succeeded"
    assert attempted == MUSIC_URLS
    assert result.selected_media["media_host"] == "lf26-music-east.douyinstatic.com"


def test_all_mirrors_failing_reports_download_failure(tmp_path, monkeypatch) -> None:
    use_detail(monkeypatch, make_aweme())
    use_download(monkeypatch, fail_urls=set(MUSIC_URLS))

    result = asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path)))

    assert result.status == "failed"
    assert result.failure_code == "AUDIO_DOWNLOAD_FAILED"


def test_short_links_are_resolved_inside_the_job(tmp_path, monkeypatch) -> None:
    resolved: list[str] = []

    async def fake_resolve(url, _settings):
        resolved.append(url)
        return AWEME_ID

    monkeypatch.setattr(douyin_music, "resolve_short_link", fake_resolve)
    detail_calls = use_detail(monkeypatch, make_aweme())
    use_download(monkeypatch)

    result = asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path, url="https://v.douyin.com/iRNBho6x/")))

    assert result.status == "succeeded"
    assert resolved == ["https://v.douyin.com/iRNBho6x/"]
    assert detail_calls == [AWEME_ID]


def test_video_audio_fallback_keeps_only_the_audio_stream(tmp_path, monkeypatch) -> None:
    use_detail(monkeypatch, make_aweme(music_urls=()))
    attempted = use_download(monkeypatch)
    extracted: list[tuple[str, str]] = []

    def fake_extract(input_path, output_path, _cancel=None):
        extracted.append((input_path.name, output_path.name))
        assert input_path.read_bytes() == FAKE_MP4
        output_path.write_bytes(b"aac-audio")
        return None

    monkeypatch.setattr(douyin_music, "ffmpeg_extract_audio", fake_extract)
    monkeypatch.setattr(
        douyin_music,
        "ffprobe_json",
        lambda _path, _cancel=None: ({"streams": [{"codec_type": "audio", "codec_name": "aac"}]}, None),
    )
    context = make_context(tmp_path)

    result = asyncio.run(DouyinMusicStrategy().run(context))

    assert result.status == "succeeded", result.reason
    assert attempted == [VIDEO_URL]
    assert extracted == [("source_video.mp4", "raw.m4a")]
    assert [path.name for path in result.raw_artifacts] == ["raw.m4a"]
    assert not (context.job_dir / "source_video.mp4").exists()
    assert result.selected_media["media_kind"] == "video_audio"
    assert result.selected_media["media_host"] == "v5-hl-mly-ov.zjcdn.com"
    assert "secret" not in str(result.selected_media)


def test_video_fallback_rejects_output_that_still_contains_video(tmp_path, monkeypatch) -> None:
    use_detail(monkeypatch, make_aweme(music_urls=()))
    use_download(monkeypatch)

    def fake_extract(_input_path, output_path, _cancel=None):
        output_path.write_bytes(b"still-video")
        return None

    monkeypatch.setattr(douyin_music, "ffmpeg_extract_audio", fake_extract)
    monkeypatch.setattr(
        douyin_music,
        "ffprobe_json",
        lambda _path, _cancel=None: ({"streams": [{"codec_type": "audio"}, {"codec_type": "video"}]}, None),
    )
    context = make_context(tmp_path)

    result = asyncio.run(DouyinMusicStrategy().run(context))

    assert result.status == "failed"
    assert result.failure_code == "AUDIO_EXTRACT_FAILED"
    assert not (context.job_dir / "raw.m4a").exists()
    assert not (context.job_dir / "source_video.mp4").exists()


def test_oversized_media_fails_without_trying_other_mirrors(tmp_path, monkeypatch) -> None:
    use_detail(monkeypatch, make_aweme())
    attempted: list[str] = []

    async def too_large(_client, url, _headers, _output_path, _settings, _cancel=None, **_limits):
        attempted.append(url)
        raise douyin_music.DownloadTooLarge("media is 999 bytes, above the 10 byte limit")

    monkeypatch.setattr(douyin_music, "download_audio", too_large)

    result = asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path)))

    assert result.status == "failed"
    assert result.failure_code == "MEDIA_TOO_LARGE"
    assert "DOUYIN_MAX_DOWNLOAD_BYTES" in result.reason
    assert attempted == MUSIC_URLS[:1]


def test_items_with_only_untrusted_media_hosts_have_no_media(tmp_path, monkeypatch) -> None:
    use_detail(
        monkeypatch,
        make_aweme(music_urls=["https://evil.example/a.mp3"], video_urls=["http://127.0.0.1/video.mp4"]),
    )
    attempted = use_download(monkeypatch)

    result = asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path)))

    assert result.status == "failed"
    assert result.failure_code == "DOUYIN_NO_MEDIA"
    assert attempted == []


def test_unavailable_items_report_douyin_failure_code(tmp_path, monkeypatch) -> None:
    async def unavailable(_aweme_id, _settings, _raise_if_cancelled=None):
        raise DouyinUnavailable("DOUYIN_ITEM_UNAVAILABLE", "Douyin item is unavailable or private (core_dep)")

    monkeypatch.setattr(douyin_music, "fetch_aweme_detail", unavailable)

    result = asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path)))

    assert result.status == "failed"
    assert result.failure_code == "DOUYIN_ITEM_UNAVAILABLE"
    assert "core_dep" in result.reason


def test_slow_page_is_retried_once_inside_the_job(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(douyin_music, "DETAIL_RETRY_DELAY_SECONDS", 0)
    use_download(monkeypatch)
    calls: list[str] = []

    async def flaky(aweme_id, _settings, _raise_if_cancelled=None):
        calls.append(aweme_id)
        if len(calls) == 1:
            raise DouyinUnavailable("DOUYIN_DETAIL_TIMEOUT", "Douyin page did not return item details in time")
        return make_aweme()

    monkeypatch.setattr(douyin_music, "fetch_aweme_detail", flaky)

    result = asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path)))

    assert result.status == "succeeded"
    assert calls == [AWEME_ID, AWEME_ID]


def test_unavailable_items_are_not_retried(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(douyin_music, "DETAIL_RETRY_DELAY_SECONDS", 0)
    calls: list[str] = []

    async def unavailable(aweme_id, _settings, _raise_if_cancelled=None):
        calls.append(aweme_id)
        raise DouyinUnavailable("DOUYIN_ITEM_UNAVAILABLE", "private")

    monkeypatch.setattr(douyin_music, "fetch_aweme_detail", unavailable)

    result = asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path)))

    assert result.failure_code == "DOUYIN_ITEM_UNAVAILABLE"
    assert calls == [AWEME_ID]


def test_repeated_browser_errors_surface_after_one_retry(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(douyin_music, "DETAIL_RETRY_DELAY_SECONDS", 0)
    calls: list[str] = []

    async def crashing(aweme_id, _settings, _raise_if_cancelled=None):
        calls.append(aweme_id)
        raise RuntimeError("net::ERR_CONNECTION_RESET")

    monkeypatch.setattr(douyin_music, "fetch_aweme_detail", crashing)

    with pytest.raises(RuntimeError, match="ERR_CONNECTION_RESET"):
        asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path)))
    assert calls == [AWEME_ID, AWEME_ID]


def test_cdn_error_pages_are_not_published_as_audio(tmp_path, monkeypatch) -> None:
    use_detail(monkeypatch, make_aweme())
    attempted: list[str] = []

    async def error_page_then_audio(_client, url, _headers, output_path, _settings, _cancel=None, **_limits):
        attempted.append(url)
        output_path.write_bytes(b"<html>403 Forbidden</html>" if url == MUSIC_URLS[0] else b"ID3-audio")
        return {"mode": "single_stream", "chunks": 1, "content_length": output_path.stat().st_size}

    monkeypatch.setattr(douyin_music, "download_audio", error_page_then_audio)

    result = asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path)))

    assert result.status == "succeeded"
    assert attempted == MUSIC_URLS
    assert result.raw_artifacts[0].read_bytes() == b"ID3-audio"


def test_only_error_pages_fail_without_leaving_a_raw_file(tmp_path, monkeypatch) -> None:
    use_detail(monkeypatch, make_aweme(video_urls=()))
    monkeypatch.setattr(douyin_music.asyncio, "sleep", _no_sleep)

    async def error_page(_client, _url, _headers, output_path, _settings, _cancel=None, **_limits):
        output_path.write_bytes(b"<html>error</html>")
        return {"mode": "single_stream", "chunks": 1, "content_length": 18}

    monkeypatch.setattr(douyin_music, "download_audio", error_page)
    context = make_context(tmp_path)

    result = asyncio.run(DouyinMusicStrategy().run(context))

    assert result.failure_code == "AUDIO_DOWNLOAD_FAILED"
    assert "not a media file" in result.reason
    assert not (context.job_dir / "raw.mp3").exists()


async def _no_sleep(_seconds) -> None:
    return None


@pytest.mark.parametrize(
    ("head", "is_media"),
    [
        (b"ID3\x04\x00\x00\x00\x00", True),
        (b"\xff\xfb\x90\x64\x00\x00", True),
        (b"\xff\xf1\x50\x80\x00\x1f", True),
        (b"\x00\x00\x00\x20ftypM4A \x00", True),
        (b"<!DOCTYPE html>", False),
        (b'{"status_code":8}', False),
        (b"ID", False),
    ],
)
def test_media_signature_check(tmp_path, head, is_media) -> None:
    path = tmp_path / "raw.bin"
    path.write_bytes(head)
    assert douyin_music._looks_like_media(path) is is_media


def test_cancellation_propagates(tmp_path, monkeypatch) -> None:
    use_detail(monkeypatch, make_aweme())
    use_download(monkeypatch)

    with pytest.raises(StrategyCancelled):
        asyncio.run(DouyinMusicStrategy().run(make_context(tmp_path, cancel=lambda: True)))
