from __future__ import annotations

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
    request_timeout_seconds: float
    api_dash_download_concurrency: int
    api_dash_parallel_min_bytes: int
    login_session_timeout_seconds: int
    login_poll_interval_seconds: int
    login_qr_refresh_seconds: int
    bilibili_login_url: str
    bilibili_user_agent: str
    cors_origins: list[str]

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
        network_capture_ms=int(os.getenv("NETWORK_CAPTURE_MS", "12000")),
        mse_capture_ms=int(os.getenv("MSE_CAPTURE_MS", os.getenv("NETWORK_CAPTURE_MS", "12000"))),
        mse_playback_rate=float(os.getenv("MSE_PLAYBACK_RATE", "4.0")),
        request_timeout_seconds=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "30")),
        api_dash_download_concurrency=_bounded_int_from_env("API_DASH_DOWNLOAD_CONCURRENCY", 2, 1, 4),
        api_dash_parallel_min_bytes=_bounded_int_from_env(
            "API_DASH_PARALLEL_MIN_BYTES",
            4 * 1024 * 1024,
            1024 * 1024,
            64 * 1024 * 1024,
        ),
        login_session_timeout_seconds=int(os.getenv("LOGIN_SESSION_TIMEOUT_SECONDS", "180")),
        login_poll_interval_seconds=int(os.getenv("LOGIN_POLL_INTERVAL_SECONDS", "3")),
        login_qr_refresh_seconds=int(os.getenv("LOGIN_QR_REFRESH_SECONDS", "60")),
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
    )


def _optional_env(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value or None
