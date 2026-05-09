from __future__ import annotations

import hashlib
import json
import mimetypes
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from .models import utc_now_iso


@dataclass(frozen=True)
class ArtifactRecord:
    name: str
    type: str
    size_bytes: int
    sha256: str
    created_at: str
    producer_strategy: str
    mime_guess: str | None


def safe_artifact_name(name: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.@-]+", name or ""):
        raise ValueError("invalid artifact name")
    if name in {".", ".."}:
        raise ValueError("invalid artifact name")
    return name


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def guess_mime(path: Path) -> str | None:
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed


def build_artifact_record(path: Path, artifact_type: str, producer_strategy: str) -> ArtifactRecord:
    return ArtifactRecord(
        name=path.name,
        type=artifact_type,
        size_bytes=path.stat().st_size,
        sha256=sha256_file(path),
        created_at=utc_now_iso(),
        producer_strategy=producer_strategy,
        mime_guess=guess_mime(path),
    )


def write_json_artifact(
    job_dir: Path,
    name: str,
    payload: object,
    artifact_type: str,
    producer_strategy: str,
) -> ArtifactRecord:
    safe_name = safe_artifact_name(name)
    path = job_dir / safe_name
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return build_artifact_record(path, artifact_type, producer_strategy)


def write_artifact_manifest(
    job_dir: Path,
    artifacts: list[ArtifactRecord],
    producer_strategy: str,
) -> ArtifactRecord:
    manifest_items = [asdict(record) for record in artifacts if record.name != "artifact_manifest.json"]
    manifest_path = job_dir / "artifact_manifest.json"
    manifest_path.write_text(
        json.dumps({"artifacts": manifest_items}, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return build_artifact_record(manifest_path, "manifest", producer_strategy)


def record_to_dict(record: ArtifactRecord) -> dict[str, object]:
    return asdict(record)
