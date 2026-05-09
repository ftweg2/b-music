from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .artifact_manager import ArtifactRecord, build_artifact_record, write_json_artifact
from .models import OutputType
from .security import sanitize_text


@dataclass(frozen=True)
class MediaPipelineResult:
    artifacts: list[ArtifactRecord]
    metadata: dict[str, object]
    warnings: list[str]


def _run_command(args: list[str], timeout: int = 120) -> tuple[int, str, str]:
    completed = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return completed.returncode, sanitize_text(completed.stdout), sanitize_text(completed.stderr)


def ffprobe_json(input_path: Path) -> tuple[dict[str, object] | None, str | None]:
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
        ]
    )
    if code != 0:
        return None, stderr or "ffprobe failed"
    try:
        return json.loads(stdout), None
    except json.JSONDecodeError:
        return None, "ffprobe returned invalid JSON"


def ffmpeg_stream_copy(input_path: Path, output_path: Path) -> str | None:
    if not shutil.which("ffmpeg"):
        return "ffmpeg not available"
    code, _stdout, stderr = _run_command(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(input_path), "-c", "copy", str(output_path)]
    )
    if code != 0:
        return stderr or "ffmpeg stream copy failed"
    return None


def ffmpeg_export_wav(input_path: Path, output_path: Path) -> str | None:
    if not shutil.which("ffmpeg"):
        return "ffmpeg not available"
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
            str(output_path),
        ]
    )
    if code != 0:
        return stderr or "ffmpeg wav export failed"
    return None


def process_media(
    input_path: Path,
    job_dir: Path,
    outputs: list[str],
    producer_strategy: str,
    extra_metadata: dict[str, object] | None = None,
) -> MediaPipelineResult:
    artifacts: list[ArtifactRecord] = []
    warnings: list[str] = []
    output_set = set(outputs)

    artifacts.append(build_artifact_record(input_path, "raw", producer_strategy))

    probe, probe_warning = ffprobe_json(input_path)
    if probe_warning:
        warnings.append(probe_warning)

    remux_input = input_path
    if OutputType.M4A in output_set:
        m4a_path = job_dir / "audio.m4a"
        warning = ffmpeg_stream_copy(input_path, m4a_path)
        if warning:
            warnings.append(warning)
        elif m4a_path.exists():
            remux_input = m4a_path
            artifacts.append(build_artifact_record(m4a_path, "m4a", producer_strategy))

    if OutputType.WAV in output_set:
        wav_path = job_dir / "audio.wav"
        warning = ffmpeg_export_wav(remux_input, wav_path)
        if warning:
            warnings.append(warning)
        elif wav_path.exists():
            artifacts.append(build_artifact_record(wav_path, "wav", producer_strategy))

    metadata = {
        "producer_strategy": producer_strategy,
        "source_file": input_path.name,
        "ffprobe": probe,
        "warnings": warnings,
    }
    if extra_metadata:
        metadata.update(extra_metadata)
    metadata_record = write_json_artifact(job_dir, "metadata.json", metadata, "metadata", producer_strategy)
    artifacts.append(metadata_record)

    return MediaPipelineResult(artifacts=artifacts, metadata=metadata, warnings=warnings)
