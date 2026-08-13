from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .artifact_manager import ArtifactRecord, build_artifact_record, write_json_artifact
from .models import OutputType
from .security import sanitize_text, sanitize_value
from .strategies.base import StrategyCancelled


@dataclass(frozen=True)
class MediaPipelineResult:
    artifacts: list[ArtifactRecord]
    metadata: dict[str, object]
    warnings: list[str]


def _run_command(
    args: list[str],
    timeout: int = 120,
    cancel_requested: Callable[[], bool] | None = None,
) -> tuple[int, str, str]:
    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        process = subprocess.Popen(args, stdout=stdout_file, stderr=stderr_file)
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if cancel_requested and cancel_requested():
                    _terminate_process(process)
                    raise StrategyCancelled("Job cancelled during media processing")
                if time.monotonic() >= deadline:
                    _terminate_process(process)
                    raise subprocess.TimeoutExpired(args, timeout)
                time.sleep(0.25)
        except BaseException:
            if process.poll() is None:
                _terminate_process(process)
            raise
        stdout_file.seek(0)
        stderr_file.seek(0)
        stdout = stdout_file.read().decode("utf-8", errors="replace")
        stderr = stderr_file.read().decode("utf-8", errors="replace")
        return process.returncode, stdout, sanitize_text(stderr)


def _terminate_process(process: subprocess.Popen[bytes]) -> None:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def ffprobe_json(
    input_path: Path,
    cancel_requested: Callable[[], bool] | None = None,
) -> tuple[dict[str, object] | None, str | None]:
    if not shutil.which("ffprobe"):
        return None, "ffprobe not available"
    code, stdout, stderr = _run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-hide_banner",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(input_path),
        ],
        cancel_requested=cancel_requested,
    )
    if code != 0:
        return None, stderr or "ffprobe failed"
    try:
        return json.loads(stdout), None
    except json.JSONDecodeError:
        return None, "ffprobe returned invalid JSON"


def ffmpeg_stream_copy(
    input_path: Path,
    output_path: Path,
    cancel_requested: Callable[[], bool] | None = None,
) -> str | None:
    if not shutil.which("ffmpeg"):
        return "ffmpeg not available"
    temp_path = _temporary_media_path(output_path)
    _unlink_if_exists(temp_path)
    try:
        code, _stdout, stderr = _run_command(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(input_path), "-c", "copy", str(temp_path)],
            cancel_requested=cancel_requested,
        )
        if code != 0:
            return stderr or "ffmpeg stream copy failed"
        if not temp_path.is_file() or temp_path.stat().st_size == 0:
            return "ffmpeg stream copy produced an empty file"
        temp_path.replace(output_path)
        return None
    finally:
        _unlink_if_exists(temp_path)


def ffmpeg_export_wav(
    input_path: Path,
    output_path: Path,
    cancel_requested: Callable[[], bool] | None = None,
) -> str | None:
    if not shutil.which("ffmpeg"):
        return "ffmpeg not available"
    temp_path = _temporary_media_path(output_path)
    _unlink_if_exists(temp_path)
    try:
        code, _stdout, stderr = _run_command(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-i",
                str(input_path),
                "-vn",
                "-acodec",
                "pcm_s16le",
                str(temp_path),
            ],
            cancel_requested=cancel_requested,
        )
        if code != 0:
            return stderr or "ffmpeg wav export failed"
        if not temp_path.is_file() or temp_path.stat().st_size == 0:
            return "ffmpeg wav export produced an empty file"
        temp_path.replace(output_path)
        return None
    finally:
        _unlink_if_exists(temp_path)


def process_media(
    input_path: Path,
    job_dir: Path,
    outputs: list[str],
    producer_strategy: str,
    extra_metadata: dict[str, object] | None = None,
    cancel_requested: Callable[[], bool] | None = None,
) -> MediaPipelineResult:
    artifacts: list[ArtifactRecord] = []
    warnings: list[str] = []
    output_set = set(outputs)

    _raise_if_cancelled(cancel_requested)
    artifacts.append(build_artifact_record(input_path, "raw", producer_strategy))

    probe, probe_warning = ffprobe_json(input_path, cancel_requested)
    if probe_warning:
        warnings.append(probe_warning)

    remux_input = input_path
    if OutputType.M4A in output_set:
        m4a_path = job_dir / "audio.m4a"
        _raise_if_cancelled(cancel_requested)
        warning = ffmpeg_stream_copy(input_path, m4a_path, cancel_requested)
        if warning:
            warnings.append(warning)
        elif m4a_path.exists():
            remux_input = m4a_path
            artifacts.append(build_artifact_record(m4a_path, "m4a", producer_strategy))

    if OutputType.WAV in output_set:
        wav_path = job_dir / "audio.wav"
        _raise_if_cancelled(cancel_requested)
        warning = ffmpeg_export_wav(remux_input, wav_path, cancel_requested)
        if warning:
            warnings.append(warning)
        elif wav_path.exists():
            artifacts.append(build_artifact_record(wav_path, "wav", producer_strategy))

    metadata = {
        "producer_strategy": producer_strategy,
        "source_file": input_path.name,
        "ffprobe": sanitize_value(probe),
        "warnings": warnings,
    }
    if extra_metadata:
        metadata.update(extra_metadata)
    metadata_record = write_json_artifact(job_dir, "metadata.json", metadata, "metadata", producer_strategy)
    artifacts.append(metadata_record)

    return MediaPipelineResult(artifacts=artifacts, metadata=metadata, warnings=warnings)


def _raise_if_cancelled(cancel_requested: Callable[[], bool] | None) -> None:
    if cancel_requested and cancel_requested():
        raise StrategyCancelled("Job cancelled during media processing")


def _temporary_media_path(path: Path) -> Path:
    return path.with_name(f".{path.stem}.tmp{path.suffix}")


def _unlink_if_exists(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
