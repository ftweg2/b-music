from __future__ import annotations

import asyncio
import json
import shutil
import threading
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .artifact_manager import (
    ArtifactRecord,
    build_artifact_record,
    safe_artifact_name,
    write_artifact_manifest,
    write_json_artifact,
)
from .config import Settings, get_settings
from .db import get_connection
from .media_pipeline import process_media
from .models import JobState, OutputType, StrategyName, StrategyStatus, utc_now_iso
from .profile_manager import (
    ProfileLockedError,
    ProfileNotFoundError,
    ProfileOwnershipError,
    is_profile_logged_in,
    release_profile_lock,
)
from .security import (
    sanitize_dict,
    sanitize_text,
    validate_bilibili_video_ref,
    validate_external_owner_id,
    validate_job_id,
    validate_profile_id,
)
from .strategies.api_dash import ApiDashStrategy
from .strategies.base import ExtractionStrategy, StrategyCancelled, StrategyContext, StrategyResult
from .strategies.browser_network import BrowserNetworkStrategy
from .strategies.mse_sourcebuffer import MseSourceBufferStrategy
from .strategy_selector import StrategyMetricSnapshot, select_strategy_order


class JobNotFoundError(LookupError):
    pass


class JobConflictError(RuntimeError):
    pass


class RequestedOutputError(RuntimeError):
    """Media extraction worked, but one or more requested outputs were not produced."""

    def __init__(self, reason: str, artifacts: list[ArtifactRecord]) -> None:
        super().__init__(reason)
        self.artifacts = artifacts


def strategy_registry() -> dict[str, ExtractionStrategy]:
    return {
        StrategyName.API_DASH: ApiDashStrategy(),
        StrategyName.BROWSER_NETWORK: BrowserNetworkStrategy(),
        StrategyName.MSE_SOURCEBUFFER: MseSourceBufferStrategy(),
    }


def job_dir(job_id: str, settings: Settings | None = None) -> Path:
    settings = settings or get_settings()
    validate_job_id(job_id)
    return settings.artifacts_dir / job_id


def create_job(request: object, settings: Settings | None = None) -> dict[str, str]:
    settings = settings or get_settings()
    validate_job_id(request.job_id)
    validate_external_owner_id(request.external_owner_id)
    validate_profile_id(request.profile_id)
    bvid = validate_bilibili_video_ref(request.url)
    canonical_url = f"https://www.bilibili.com/video/{bvid}"
    if request.strategy_mode == "force" and not request.strategy:
        raise ValueError("force mode requires strategy")
    now = utc_now_iso()
    outputs = list(dict.fromkeys(request.outputs))
    settings.artifacts_dir.mkdir(parents=True, exist_ok=True)
    target_dir = job_dir(request.job_id, settings)
    with get_connection(settings) as conn:
        conn.execute("BEGIN IMMEDIATE")
        duplicate = conn.execute("SELECT job_id FROM jobs WHERE job_id=?", (request.job_id,)).fetchone()
        if duplicate:
            raise JobConflictError("job_id already exists")

        profile = conn.execute(
            "SELECT * FROM profiles WHERE profile_id=?",
            (request.profile_id,),
        ).fetchone()
        if not profile:
            raise ProfileNotFoundError(request.profile_id)
        if profile["external_owner_id"] != request.external_owner_id:
            raise ProfileOwnershipError("profile does not belong to external_owner_id")

        lock = conn.execute(
            """
            UPDATE profiles
            SET active_job_id=?, updated_at=?
            WHERE profile_id=? AND (active_job_id IS NULL OR active_job_id='')
            """,
            (request.job_id, now, request.profile_id),
        )
        if lock.rowcount != 1:
            raise ProfileLockedError("profile already has an active job")

        conn.execute(
            """
            INSERT INTO jobs (
                job_id, external_owner_id, profile_id, url, strategy_mode, strategy,
                strategy_order_json, outputs_json, status, stage, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                request.job_id,
                request.external_owner_id,
                request.profile_id,
                canonical_url,
                request.strategy_mode,
                request.strategy,
                json.dumps(request.strategy_order),
                json.dumps(outputs),
                JobState.QUEUED,
                JobState.QUEUED,
                now,
                now,
            ),
        )

    try:
        target_dir.mkdir()
    except FileExistsError as exc:
        _rollback_created_job(request.job_id, request.profile_id, settings)
        raise JobConflictError("job artifact directory already exists") from exc
    except OSError:
        _rollback_created_job(request.job_id, request.profile_id, settings)
        raise

    return {"job_id": request.job_id, "status": JobState.QUEUED, "stage": JobState.QUEUED}


def _rollback_created_job(job_id_value: str, profile_id: str, settings: Settings) -> None:
    with get_connection(settings) as conn:
        conn.execute("DELETE FROM jobs WHERE job_id=?", (job_id_value,))
        conn.execute(
            """
            UPDATE profiles SET active_job_id=NULL, updated_at=?
            WHERE profile_id=? AND active_job_id=?
            """,
            (utc_now_iso(), profile_id, job_id_value),
        )


async def run_job(job_id_value: str, settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    selected_strategy: str | None = None
    profile_id: str | None = None
    local_cancel = threading.Event()
    try:
        job = _get_job_row(job_id_value, settings)
        profile_id = str(job["profile_id"])
        _update_job_state(job_id_value, JobState.VALIDATING_PROFILE, settings)
        profile = _get_profile_for_job(job, settings)
        if _cancel_requested(job_id_value, settings):
            _mark_cancelled(job_id_value, settings)
            return

        _update_job_state(job_id_value, JobState.PREPARING_CONTEXT, settings)
        registry = strategy_registry()
        metrics = _load_strategy_metrics(settings)
        order = select_strategy_order(
            strategy_mode=str(job["strategy_mode"]),
            requested_strategy=job["strategy"],
            strategy_order=json.loads(job["strategy_order_json"] or "null"),
            available_strategies=list(registry.keys()),
            metrics=metrics,
            logged_in=is_profile_logged_in(profile),
            context_hints={},
        )
        context = StrategyContext(
            job_id=job_id_value,
            external_owner_id=str(job["external_owner_id"]),
            profile_id=profile_id,
            url=str(job["url"]),
            outputs=json.loads(job["outputs_json"]),
            job_dir=job_dir(job_id_value, settings),
            settings=settings,
            logged_in=is_profile_logged_in(profile),
            context_hints={},
            cancel_requested=lambda: (
                local_cancel.is_set() or _cancel_requested(job_id_value, settings)
            ),
        )

        last_result: StrategyResult | None = None
        for strategy_name in order:
            if _cancel_requested(job_id_value, settings):
                _mark_cancelled(job_id_value, settings)
                return
            strategy = registry[strategy_name]
            _update_job_state(job_id_value, _stage_for_strategy(strategy_name), settings)
            if not strategy.supports(context):
                result = StrategyResult.failed(
                    failure_code="UNSUPPORTED_CONTEXT",
                    reason="Strategy does not support this job context",
                )
            else:
                result = await strategy.run(context)
            last_result = result
            duration_ms = int(result.timings.get("duration_ms") or 0)
            _record_attempt(job_id_value, strategy_name, result, duration_ms, settings)
            _write_strategy_report(job_id_value, settings)

            if result.status == StrategyStatus.SUCCEEDED:
                if _cancel_requested(job_id_value, settings):
                    _mark_cancelled(job_id_value, settings)
                    return
                selected_strategy = strategy_name
                _update_job_state(job_id_value, JobState.PROCESSING_MEDIA, settings, selected_strategy)
                artifacts = await asyncio.to_thread(
                    _process_successful_result,
                    context,
                    result,
                    strategy_name,
                    settings,
                )
                if _cancel_requested(job_id_value, settings):
                    _mark_cancelled(job_id_value, settings)
                    return
                _save_artifacts(job_id_value, context.job_dir, artifacts, settings)
                _update_job_state(job_id_value, JobState.SUCCEEDED, settings, selected_strategy)
                return

        if _cancel_requested(job_id_value, settings):
            _mark_cancelled(job_id_value, settings)
            return
        failure_reason = "All strategies failed"
        if last_result:
            failure_reason = last_result.reason
        _write_failure_artifacts(job_id_value, failure_reason, settings)
        _update_job_state(job_id_value, JobState.FAILED, settings, selected_strategy, failure_reason)
    except StrategyCancelled:
        _mark_cancelled(job_id_value, settings)
    except asyncio.CancelledError:
        local_cancel.set()
        _mark_cancelled(job_id_value, settings)
        raise
    except RequestedOutputError as exc:
        _save_artifacts(job_id_value, job_dir(job_id_value, settings), exc.artifacts, settings)
        _update_job_state(
            job_id_value,
            JobState.FAILED,
            settings,
            selected_strategy,
            sanitize_text(exc),
        )
    except Exception as exc:
        _write_failure_artifacts(job_id_value, sanitize_text(exc), settings)
        _update_job_state(job_id_value, JobState.FAILED, settings, selected_strategy, sanitize_text(exc))
    finally:
        if profile_id:
            release_profile_lock(profile_id, job_id_value, settings)


def get_job_status(job_id_value: str, settings: Settings | None = None) -> dict[str, object]:
    settings = settings or get_settings()
    job = _get_job_row(job_id_value, settings)
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "stage": job["stage"],
        "selected_strategy": job["selected_strategy"],
        "fallback_attempts": _list_attempts(job_id_value, settings),
        "sanitized_error": job["sanitized_error"],
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
    }


def verify_job_owner(
    job_id_value: str,
    external_owner_id: str,
    settings: Settings | None = None,
) -> dict[str, object]:
    settings = settings or get_settings()
    validate_external_owner_id(external_owner_id)
    job = _get_job_row(job_id_value, settings)
    if job["external_owner_id"] != external_owner_id:
        raise ProfileOwnershipError("job does not belong to external_owner_id")
    return job


def request_cancel(job_id_value: str, settings: Settings | None = None) -> dict[str, str]:
    settings = settings or get_settings()
    job = _get_job_row(job_id_value, settings)
    if str(job["status"]) in JobState.TERMINAL:
        return {"job_id": job_id_value, "status": str(job["status"])}
    with get_connection(settings) as conn:
        conn.execute("UPDATE jobs SET cancel_requested=1, updated_at=? WHERE job_id=?", (utc_now_iso(), job_id_value))
    return {"job_id": job_id_value, "status": "cancel_requested"}


def recover_interrupted_runtime(settings: Settings | None = None) -> dict[str, int]:
    settings = settings or get_settings()
    now = utc_now_iso()
    with get_connection(settings) as conn:
        interrupted = conn.execute(
            """
            SELECT job_id FROM jobs
            WHERE status NOT IN (?, ?, ?)
            """,
            (JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED),
        ).fetchall()
        job_ids = [str(row["job_id"]) for row in interrupted]
        if job_ids:
            placeholders = ",".join("?" for _ in job_ids)
            conn.execute(
                f"""
                UPDATE jobs
                SET status=?, stage=?, sanitized_error=?, updated_at=?, finished_at=?
                WHERE job_id IN ({placeholders})
                """,
                (
                    JobState.FAILED,
                    JobState.FAILED,
                    "kernel restarted before this job reached a terminal state",
                    now,
                    now,
                    *job_ids,
                ),
            )
        locks = conn.execute(
            "SELECT profile_id FROM profiles WHERE active_job_id IS NOT NULL AND active_job_id<>''"
        ).fetchall()
        conn.execute(
            """
            UPDATE profiles
            SET active_job_id=NULL, updated_at=?
            WHERE active_job_id IS NOT NULL AND active_job_id<>''
            """,
            (now,),
        )
    # Recovery is a terminal transition too: consumers must see the same
    # failure artifacts as they would for an in-process failure.
    for job_id_value in job_ids:
        _write_failure_artifacts(
            job_id_value,
            "kernel restarted before this job reached a terminal state",
            settings,
        )
    return {"jobs_marked_failed": len(job_ids), "profile_locks_released": len(locks)}


def cleanup_old_artifacts(settings: Settings | None = None, retention_hours: int | None = None) -> dict[str, int]:
    settings = settings or get_settings()
    retention = retention_hours if retention_hours is not None else settings.artifact_retention_hours
    cutoff = datetime.now(UTC) - timedelta(hours=max(1, retention))
    root = settings.artifacts_dir.resolve()
    removed_jobs = 0
    removed_files = 0
    removed_bytes = 0
    with get_connection(settings) as conn:
        rows = conn.execute(
            """
            SELECT job_id, COALESCE(finished_at, updated_at, created_at) AS terminal_at
            FROM jobs
            WHERE status IN (?, ?, ?)
            """,
            (JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED),
        ).fetchall()
    expired = [
        str(row["job_id"])
        for row in rows
        if (terminal_at := _parse_iso(str(row["terminal_at"]))) is not None
        and terminal_at <= cutoff
    ]
    removed_job_ids: list[str] = []
    for job_id_value in expired:
        target = job_dir(job_id_value, settings).resolve()
        if root not in target.parents:
            continue
        if target.exists():
            for file_path in target.rglob("*"):
                if file_path.is_file():
                    try:
                        removed_files += 1
                        removed_bytes += file_path.stat().st_size
                    except FileNotFoundError:
                        continue
            shutil.rmtree(target, ignore_errors=True)
        if not target.exists():
            removed_job_ids.append(job_id_value)

    if removed_job_ids:
        with get_connection(settings) as conn:
            for job_id_value in removed_job_ids:
                conn.execute("DELETE FROM artifacts WHERE job_id=?", (job_id_value,))
    removed_jobs = len(removed_job_ids)
    return {"artifact_jobs_removed": removed_jobs, "artifact_files_removed": removed_files, "artifact_bytes_removed": removed_bytes}


def diagnostics(settings: Settings | None = None) -> dict[str, object]:
    settings = settings or get_settings()
    root = settings.artifacts_dir.resolve()
    artifact_file_count = 0
    artifact_bytes = 0
    if root.exists():
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            try:
                artifact_bytes += path.stat().st_size
                artifact_file_count += 1
            except FileNotFoundError:
                continue
    with get_connection(settings) as conn:
        job_states = conn.execute(
            "SELECT status, COUNT(*) AS count FROM jobs GROUP BY status ORDER BY status"
        ).fetchall()
        active_locks = conn.execute(
            """
            SELECT profile_id, external_owner_id, active_job_id, updated_at
            FROM profiles
            WHERE active_job_id IS NOT NULL AND active_job_id<>''
            ORDER BY updated_at
            """
        ).fetchall()
        nonterminal_jobs = conn.execute(
            """
            SELECT job_id, status, stage, updated_at
            FROM jobs
            WHERE status NOT IN (?, ?, ?)
            ORDER BY updated_at
            """,
            (JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED),
        ).fetchall()
        orphan_artifacts = conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM artifacts a
            LEFT JOIN jobs j ON j.job_id=a.job_id
            WHERE j.job_id IS NULL
            """
        ).fetchone()
    return {
        "status": "ok",
        "job_states": [dict(row) for row in job_states],
        "active_locks": [dict(row) for row in active_locks],
        "nonterminal_jobs": [dict(row) for row in nonterminal_jobs],
        "orphan_artifact_rows": int(orphan_artifacts["count"] if orphan_artifacts else 0),
        "artifact_files": artifact_file_count,
        "artifact_bytes": artifact_bytes,
        "artifact_retention_hours": settings.artifact_retention_hours,
    }


def list_artifacts(job_id_value: str, settings: Settings | None = None) -> list[dict[str, object]]:
    settings = settings or get_settings()
    _get_job_row(job_id_value, settings)
    with get_connection(settings) as conn:
        rows = conn.execute(
            """
            SELECT name, type, size_bytes, sha256, created_at, producer_strategy, mime_guess
            FROM artifacts
            WHERE job_id=?
            ORDER BY id
            """,
            (job_id_value,),
        ).fetchall()
    return [dict(row) for row in rows]


def artifact_path(job_id_value: str, name: str, settings: Settings | None = None) -> Path:
    settings = settings or get_settings()
    _get_job_row(job_id_value, settings)
    safe_name = safe_artifact_name(name)
    with get_connection(settings) as conn:
        row = conn.execute(
            "SELECT path FROM artifacts WHERE job_id=? AND name=?",
            (job_id_value, safe_name),
        ).fetchone()
    if not row:
        raise FileNotFoundError(safe_name)
    path = Path(row["path"]).resolve()
    root = settings.artifacts_dir.resolve()
    if root not in path.parents and path != root:
        raise PermissionError("artifact path escaped artifact root")
    if not path.is_file():
        raise FileNotFoundError(safe_name)
    return path


def strategy_metrics(settings: Settings | None = None) -> list[dict[str, object]]:
    settings = settings or get_settings()
    with get_connection(settings) as conn:
        for strategy_name in StrategyName.ALL:
            conn.execute(
                "INSERT OR IGNORE INTO strategy_metrics (strategy_name) VALUES (?)",
                (strategy_name,),
            )
        rows = conn.execute(
            """
            SELECT strategy_name, total_attempts, success_count, fail_count, last_success_at,
                   last_failure_at, last_failure_reason, avg_duration_ms
            FROM strategy_metrics
            ORDER BY strategy_name
            """
        ).fetchall()
    return [dict(row) for row in rows]


def _get_job_row(job_id_value: str, settings: Settings) -> dict[str, object]:
    validate_job_id(job_id_value)
    with get_connection(settings) as conn:
        row = conn.execute("SELECT * FROM jobs WHERE job_id=?", (job_id_value,)).fetchone()
    if not row:
        raise JobNotFoundError(job_id_value)
    return dict(row)


def _get_profile_for_job(job: dict[str, object], settings: Settings) -> dict[str, object]:
    with get_connection(settings) as conn:
        row = conn.execute("SELECT * FROM profiles WHERE profile_id=?", (job["profile_id"],)).fetchone()
    if not row:
        raise ProfileNotFoundError(str(job["profile_id"]))
    profile = dict(row)
    if profile["external_owner_id"] != job["external_owner_id"]:
        raise ProfileOwnershipError("profile does not belong to external_owner_id")
    return profile


def _update_job_state(
    job_id_value: str,
    state: str,
    settings: Settings,
    selected_strategy: str | None = None,
    error: str | None = None,
) -> None:
    now = utc_now_iso()
    with get_connection(settings) as conn:
        if state == JobState.SUCCEEDED or state == JobState.FAILED or state == JobState.CANCELLED:
            conn.execute(
                """
                UPDATE jobs
                SET status=?, stage=?, selected_strategy=COALESCE(?, selected_strategy),
                    sanitized_error=?, updated_at=?, finished_at=?
                WHERE job_id=?
                """,
                (state, state, selected_strategy, sanitize_text(error) if error else None, now, now, job_id_value),
            )
        elif state == JobState.VALIDATING_PROFILE:
            conn.execute(
                """
                UPDATE jobs
                SET status=?, stage=?, selected_strategy=COALESCE(?, selected_strategy),
                    updated_at=?, started_at=COALESCE(started_at, ?)
                WHERE job_id=?
                """,
                (state, state, selected_strategy, now, now, job_id_value),
            )
        else:
            conn.execute(
                """
                UPDATE jobs
                SET status=?, stage=?, selected_strategy=COALESCE(?, selected_strategy), updated_at=?
                WHERE job_id=?
                """,
                (state, state, selected_strategy, now, job_id_value),
            )


def _stage_for_strategy(strategy_name: str) -> str:
    return f"running_{strategy_name}"


def _cancel_requested(job_id_value: str, settings: Settings) -> bool:
    with get_connection(settings) as conn:
        row = conn.execute("SELECT cancel_requested FROM jobs WHERE job_id=?", (job_id_value,)).fetchone()
    return bool(row and row["cancel_requested"])


def _mark_cancelled(job_id_value: str, settings: Settings) -> None:
    _write_failure_artifacts(job_id_value, "Job cancelled", settings)
    _update_job_state(job_id_value, JobState.CANCELLED, settings, error="Job cancelled")


def _record_attempt(
    job_id_value: str,
    strategy_name: str,
    result: StrategyResult,
    duration_ms: int,
    settings: Settings,
) -> None:
    now = utc_now_iso()
    debug_info = sanitize_dict(result.sanitized_debug_info)
    with get_connection(settings) as conn:
        conn.execute(
            """
            INSERT INTO strategy_attempts (
                job_id, strategy_name, status, failure_code, reason,
                duration_ms, sanitized_debug_info_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id_value,
                strategy_name,
                result.status,
                result.failure_code,
                sanitize_text(result.reason),
                duration_ms,
                json.dumps(debug_info, sort_keys=True),
                now,
            ),
        )
        metric = conn.execute(
            "SELECT * FROM strategy_metrics WHERE strategy_name=?",
            (strategy_name,),
        ).fetchone()
        if metric:
            total_before = int(metric["total_attempts"])
            avg_before = float(metric["avg_duration_ms"])
        else:
            total_before = 0
            avg_before = 0.0
            conn.execute("INSERT INTO strategy_metrics (strategy_name) VALUES (?)", (strategy_name,))
        total_after = total_before + 1
        avg_after = ((avg_before * total_before) + duration_ms) / total_after
        success_delta = 1 if result.status == StrategyStatus.SUCCEEDED else 0
        fail_delta = 1 if result.status == StrategyStatus.FAILED else 0
        conn.execute(
            """
            UPDATE strategy_metrics
            SET total_attempts=total_attempts+1,
                success_count=success_count+?,
                fail_count=fail_count+?,
                last_success_at=CASE WHEN ?=1 THEN ? ELSE last_success_at END,
                last_failure_at=CASE WHEN ?=1 THEN ? ELSE last_failure_at END,
                last_failure_reason=CASE WHEN ?=1 THEN ? ELSE last_failure_reason END,
                avg_duration_ms=?
            WHERE strategy_name=?
            """,
            (
                success_delta,
                fail_delta,
                success_delta,
                now,
                fail_delta,
                now,
                fail_delta,
                result.failure_code or sanitize_text(result.reason),
                avg_after,
                strategy_name,
            ),
        )


def _list_attempts(job_id_value: str, settings: Settings) -> list[dict[str, object]]:
    with get_connection(settings) as conn:
        rows = conn.execute(
            """
            SELECT strategy_name, status, failure_code, reason, duration_ms,
                   sanitized_debug_info_json, created_at
            FROM strategy_attempts
            WHERE job_id=?
            ORDER BY id
            """,
            (job_id_value,),
        ).fetchall()
    attempts = []
    for row in rows:
        item = dict(row)
        item["sanitized_debug_info"] = json.loads(item.pop("sanitized_debug_info_json") or "{}")
        attempts.append(item)
    return attempts


def _load_strategy_metrics(settings: Settings) -> dict[str, StrategyMetricSnapshot]:
    rows = strategy_metrics(settings)
    return {
        row["strategy_name"]: StrategyMetricSnapshot(
            strategy_name=row["strategy_name"],
            total_attempts=int(row["total_attempts"]),
            success_count=int(row["success_count"]),
            fail_count=int(row["fail_count"]),
            last_failure_reason=row["last_failure_reason"],
            avg_duration_ms=float(row["avg_duration_ms"]),
        )
        for row in rows
    }


def _write_strategy_report(job_id_value: str, settings: Settings) -> ArtifactRecord:
    target_dir = job_dir(job_id_value, settings)
    target_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "job_id": job_id_value,
        "attempts": _list_attempts(job_id_value, settings),
    }
    return write_json_artifact(target_dir, "strategy_report.json", report, "strategy_report", "kernel")


def _process_successful_result(
    context: StrategyContext,
    result: StrategyResult,
    strategy_name: str,
    settings: Settings,
) -> list[ArtifactRecord]:
    if not result.raw_artifacts:
        raise RuntimeError("strategy succeeded without raw artifact")
    primary_raw = result.raw_artifacts[0]
    pipeline = process_media(
        primary_raw,
        context.job_dir,
        context.outputs,
        strategy_name,
        extra_metadata={
            "selected_media": sanitize_dict(result.selected_media or {}),
            "strategy_warnings": pipeline_warnings(result),
        },
        cancel_requested=context.cancel_requested,
    )
    artifacts = list(pipeline.artifacts)
    for extra_path in result.raw_artifacts[1:]:
        if extra_path.exists():
            artifacts.append(build_artifact_record(extra_path, "strategy_aux", strategy_name))
    produced_types = {record.type for record in artifacts}
    missing_outputs = [output for output in context.outputs if output not in produced_types]
    if missing_outputs:
        requested_names = {
            OutputType.RAW: primary_raw.name,
            OutputType.M4A: "audio.m4a",
            OutputType.WAV: "audio.wav",
        }
        missing_names = [requested_names.get(output, output) for output in missing_outputs]
        reason = f"requested output artifacts were not produced: {', '.join(missing_names)}"
        if pipeline.warnings:
            reason += f"; media warnings: {'; '.join(pipeline.warnings)}"
        sanitized_reason = sanitize_text(reason)
        failure_metadata = dict(pipeline.metadata)
        failure_metadata.update({"status": "failed", "reason": sanitized_reason})
        metadata_record = write_json_artifact(
            context.job_dir,
            "metadata.json",
            failure_metadata,
            "metadata",
            strategy_name,
        )
        artifacts = [record for record in artifacts if record.name != "metadata.json"]
        artifacts.append(metadata_record)
        report_record = _write_strategy_report(context.job_id, settings)
        artifacts.append(report_record)
        manifest_record = write_artifact_manifest(context.job_dir, artifacts, strategy_name)
        artifacts.append(manifest_record)
        raise RequestedOutputError(sanitized_reason, artifacts)
    report_record = _write_strategy_report(context.job_id, settings)
    artifacts.append(report_record)
    manifest_record = write_artifact_manifest(context.job_dir, artifacts, strategy_name)
    artifacts.append(manifest_record)
    return artifacts


def pipeline_warnings(result: StrategyResult) -> list[str]:
    warnings = result.sanitized_debug_info.get("warnings")
    if isinstance(warnings, list):
        return [sanitize_text(warning) for warning in warnings]
    return []


def _write_failure_artifacts(
    job_id_value: str,
    reason: str,
    settings: Settings,
) -> None:
    target_dir = job_dir(job_id_value, settings)
    target_dir.mkdir(parents=True, exist_ok=True)
    report_record = _write_strategy_report(job_id_value, settings)
    metadata_record = write_json_artifact(
        target_dir,
        "metadata.json",
        {"status": "failed", "reason": sanitize_text(reason)},
        "metadata",
        "kernel",
    )
    manifest_record = write_artifact_manifest(target_dir, [report_record, metadata_record], "kernel")
    _save_artifacts(job_id_value, target_dir, [report_record, metadata_record, manifest_record], settings)


def _save_artifacts(
    job_id_value: str,
    target_dir: Path,
    artifacts: list[ArtifactRecord],
    settings: Settings,
) -> None:
    with get_connection(settings) as conn:
        for record in artifacts:
            path = (target_dir / record.name).resolve()
            conn.execute(
                """
                INSERT OR REPLACE INTO artifacts (
                    job_id, name, path, type, size_bytes, sha256, created_at,
                    producer_strategy, mime_guess
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id_value,
                    record.name,
                    str(path),
                    record.type,
                    record.size_bytes,
                    record.sha256,
                    record.created_at,
                    record.producer_strategy,
                    record.mime_guess,
                ),
            )


def _parse_iso(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)
