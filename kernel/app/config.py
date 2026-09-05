from __future__ import annotations

import math
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


def _bool_from_env(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _bounded_int_from_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    data_dir: Path
    db_path: Path
    artifacts_dir: Path
    profiles_dir: Path
    playwright_headless: bool
    playwright_browser_channel: str | None
    network_capture_ms: int
    mse_capture_ms: int
    mse_playback_rate: float
    mse_max_segment_bytes: int
    mse_max_capture_bytes: int
    mse_max_segments: int
    request_timeout_seconds: float
    api_dash_download_concurrency: int
    api_dash_parallel_min_bytes: int
    artifact_retention_hours: int
    login_session_timeout_seconds: int
    login_poll_interval_seconds: int
    login_qr_refresh_seconds: int
    bilibili_login_url: str
    bilibili_user_agent: str
    cors_origins: list[str]
    operator_token: str | None
    max_active_jobs: int = 2
    job_timeout_seconds: float = 300.0
    shutdown_grace_seconds: float = 10.0

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self.profiles_dir.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    data_dir = Path(os.getenv("KERNEL_DATA_DIR", "storage")).resolve()
    return Settings(
        host=os.getenv("KERNEL_HOST", "0.0.0.0"),
        port=int(os.getenv("KERNEL_PORT", "8000")),
        data_dir=data_dir,
        db_path=Path(os.getenv("KERNEL_DB_PATH", str(data_dir / "kernel.sqlite3"))).resolve(),
        artifacts_dir=Path(
            os.getenv("KERNEL_ARTIFACTS_DIR", str(data_dir / "artifacts"))
        ).resolve(),
        profiles_dir=Path(
            os.getenv("KERNEL_PROFILES_DIR", str(data_dir / "profiles"))
        ).resolve(),
        playwright_headless=_bool_from_env(os.getenv("PLAYWRIGHT_HEADLESS"), True),
        playwright_browser_channel=_optional_env("PLAYWRIGHT_BROWSER_CHANNEL"),
        network_capture_ms=_bounded_int_from_env("NETWORK_CAPTURE_MS", 12000, 1000, 300_000),
        mse_capture_ms=_bounded_int_from_env("MSE_CAPTURE_MS", 45000, 1000, 600_000),
        mse_playback_rate=_bounded_float_from_env("MSE_PLAYBACK_RATE", 4.0, 0.25, 16.0),
        mse_max_segment_bytes=_bounded_int_from_env(
            "MSE_MAX_SEGMENT_BYTES", 16 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024
        ),
        mse_max_capture_bytes=_bounded_int_from_env(
            "MSE_MAX_CAPTURE_BYTES", 512 * 1024 * 1024, 16 * 1024 * 1024, 2 * 1024 * 1024 * 1024
        ),
        mse_max_segments=_bounded_int_from_env("MSE_MAX_SEGMENTS", 4096, 16, 100_000),
        request_timeout_seconds=_bounded_float_from_env(
            "REQUEST_TIMEOUT_SECONDS", 30.0, 1.0, 300.0
        ),
        api_dash_download_concurrency=_bounded_int_from_env("API_DASH_DOWNLOAD_CONCURRENCY", 2, 1, 4),
        api_dash_parallel_min_bytes=_bounded_int_from_env(
            "API_DASH_PARALLEL_MIN_BYTES",
            4 * 1024 * 1024,
            1024 * 1024,
            64 * 1024 * 1024,
        ),
        artifact_retention_hours=_bounded_int_from_env("ARTIFACT_RETENTION_HOURS", 168, 1, 24 * 365),
        login_session_timeout_seconds=_bounded_int_from_env(
            "LOGIN_SESSION_TIMEOUT_SECONDS", 180, 30, 3600
        ),
        login_poll_interval_seconds=_bounded_int_from_env(
            "LOGIN_POLL_INTERVAL_SECONDS", 3, 1, 60
        ),
        login_qr_refresh_seconds=_bounded_int_from_env(
            "LOGIN_QR_REFRESH_SECONDS", 60, 10, 600
        ),
        bilibili_login_url=os.getenv("BILIBILI_LOGIN_URL", "https://passport.bilibili.com/login"),
        bilibili_user_agent=os.getenv(
            "BILIBILI_USER_AGENT",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        ),
        cors_origins=[
            origin.strip()
            for origin in os.getenv(
                "KERNEL_CORS_ORIGINS",
                "http://localhost:9000,http://127.0.0.1:9000",
            ).split(",")
            if origin.strip()
        ],
        operator_token=_optional_env("KERNEL_OPERATOR_TOKEN"),
        max_active_jobs=_bounded_int_from_env("MAX_ACTIVE_JOBS", 2, 1, 8),
        job_timeout_seconds=_bounded_float_from_env("JOB_TIMEOUT_SECONDS", 300.0, 30.0, 1800.0),
        shutdown_grace_seconds=_bounded_float_from_env("SHUTDOWN_GRACE_SECONDS", 10.0, 1.0, 30.0),
    )


def _optional_env(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _bounded_float_from_env(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        value = default
    if not math.isfinite(value):
        value = default
    return max(minimum, min(maximum, value))
