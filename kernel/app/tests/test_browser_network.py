from app.strategies.browser_network import _audio_probe_summary


def test_audio_probe_summary_accepts_audio_only_stream() -> None:
    summary = _audio_probe_summary(
        {
            "streams": [
                {"codec_type": "audio", "codec_name": "aac"},
            ]
        }
    )

    assert summary == {
        "has_audio": True,
        "has_video": False,
        "codec_types": ["audio"],
        "audio_codecs": ["aac"],
        "video_codecs": [],
    }


def test_audio_probe_summary_rejects_video_only_stream() -> None:
    summary = _audio_probe_summary(
        {
            "streams": [
                {"codec_type": "video", "codec_name": "av1"},
            ]
        }
    )

    assert summary["has_audio"] is False
    assert summary["has_video"] is True
    assert summary["video_codecs"] == ["av1"]
