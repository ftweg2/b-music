from __future__ import annotations

from datetime import UTC, datetime


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


class JobState:
    QUEUED = "queued"
    VALIDATING_PROFILE = "validating_profile"
    PREPARING_CONTEXT = "preparing_context"
    RUNNING_API_DASH = "running_api_dash"
    RUNNING_BROWSER_NETWORK = "running_browser_network"
    RUNNING_MSE_SOURCEBUFFER = "running_mse_sourcebuffer"
    PROCESSING_MEDIA = "processing_media"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

    TERMINAL = {SUCCEEDED, FAILED, CANCELLED}


class StrategyName:
    API_DASH = "api_dash"
    BROWSER_NETWORK = "browser_network"
    MSE_SOURCEBUFFER = "mse_sourcebuffer"

    ALL = [API_DASH, BROWSER_NETWORK, MSE_SOURCEBUFFER]


class StrategyMode:
    AUTO = "auto"
    FORCE = "force"


class StrategyStatus:
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class OutputType:
    RAW = "raw"
    M4A = "m4a"
    WAV = "wav"

    ALL = [RAW, M4A, WAV]


class LoginStatus:
    UNKNOWN = "unknown"
    PENDING = "pending"
    LOGGED_IN = "logged_in"
    LOGGED_OUT = "logged_out"
