import shutil
import subprocess
import sys

import pytest

from app.media_pipeline import _run_command, audio_only_problem, ffmpeg_extract_audio, ffprobe_json
from app.strategies.base import StrategyCancelled


@pytest.mark.parametrize(
    ("probe", "problem"),
    [
        ({"streams": [{"codec_type": "audio"}]}, None),
        ({"streams": [{"codec_type": "audio"}, {"codec_type": "video"}]}, "unexpected non-audio streams: video"),
        ({"streams": [{"codec_type": "video"}]}, "no audio stream found"),
        ({"streams": []}, "no media streams found"),
        (None, "no media streams found"),
    ],
)
def test_audio_only_problem(probe, problem) -> None:
    assert audio_only_problem(probe) == problem


@pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg/ffprobe not installed")
def test_extract_audio_copies_only_the_audio_stream(tmp_path) -> None:
    video = tmp_path / "source_video.mp4"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-c:v", "libx264", "-c:a", "aac", "-shortest", str(video),
        ],
        check=True,
    )
    output = tmp_path / "raw.m4a"

    assert ffmpeg_extract_audio(video, output) is None
    probe, warning = ffprobe_json(output)

    assert warning is None
    assert audio_only_problem(probe) is None
    assert [stream["codec_name"] for stream in probe["streams"]] == ["aac"]


def test_run_command_can_cancel_child_process() -> None:
    checks = 0

    def cancel_requested() -> bool:
        nonlocal checks
        checks += 1
        return checks > 1

    with pytest.raises(StrategyCancelled):
        _run_command(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            timeout=5,
            cancel_requested=cancel_requested,
        )


def test_run_command_enforces_timeout() -> None:
    with pytest.raises(subprocess.TimeoutExpired):
        _run_command(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            timeout=0,
        )
