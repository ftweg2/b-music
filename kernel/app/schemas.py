from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .models import OutputType, StrategyMode, StrategyName


StrategyLiteral = Literal["api_dash", "browser_network", "mse_sourcebuffer"]
OutputLiteral = Literal["raw", "m4a", "wav"]


class ProfileCreateRequest(BaseModel):
    external_owner_id: str = Field(min_length=1, max_length=128)


class ProfileCreateResponse(BaseModel):
    profile_id: str
    external_owner_id: str
    status: Literal["created", "exists"]


class LoginStartResponse(BaseModel):
    login_session_id: str
    status: Literal["pending"]
    message: str
    qr_image_url: str | None = None
    qr_image_sha256: str | None = None
    expires_in_seconds: int | None = None


class LoginStartRequest(BaseModel):
    external_owner_id: str = Field(min_length=1, max_length=128)


class LoginStatusResponse(BaseModel):
    profile_id: str
    logged_in: bool
    bili_uid: str | None = None
    nickname: str | None = None
    last_verified_at: str | None = None
    login_status: str = "unknown"


class CookieImportRequest(BaseModel):
    external_owner_id: str = Field(min_length=1, max_length=128)
    format: Literal["cookie_header", "netscape", "json", "playwright_storage_state"]
    cookies: Any
    source_note: str | None = Field(default=None, max_length=512)


class CookieImportResponse(BaseModel):
    profile_id: str
    status: Literal["imported"]
    logged_in: bool
    bili_uid: str | None = None
    nickname: str | None = None
    last_verified_at: str | None = None
    message: str


class JobCreateRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=128)
    external_owner_id: str = Field(min_length=1, max_length=128)
    profile_id: str
    url: str
    strategy_mode: Literal["auto", "force"] = StrategyMode.AUTO
    strategy: StrategyLiteral | None = None
    strategy_order: list[StrategyLiteral] | None = Field(default=None, min_length=1, max_length=3)
    outputs: list[OutputLiteral] = Field(default_factory=lambda: [OutputType.RAW, OutputType.M4A], min_length=1, max_length=3)


class JobCreateResponse(BaseModel):
    job_id: str
    status: str
    stage: str
    reused: bool = False


class StrategyAttemptSummary(BaseModel):
    strategy_name: str
    status: str
    failure_code: str | None = None
    reason: str
    duration_ms: int
    sanitized_debug_info: dict[str, object]
    created_at: str


class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    stage: str
    selected_strategy: str | None = None
    fallback_attempts: list[StrategyAttemptSummary]
    sanitized_error: str | None = None
    created_at: str
    updated_at: str


class JobAccessRequest(BaseModel):
    external_owner_id: str = Field(min_length=1, max_length=128)


class CancelResponse(BaseModel):
    job_id: str
    status: str


class ArtifactInfo(BaseModel):
    name: str
    type: str
    size_bytes: int
    sha256: str
    created_at: str
    producer_strategy: str
    mime_guess: str | None = None


class ArtifactListResponse(BaseModel):
    job_id: str
    artifacts: list[ArtifactInfo]


class VideoSearchRequest(BaseModel):
    external_owner_id: str = Field(min_length=1, max_length=128)
    profile_id: str
    keyword: str = Field(min_length=1, max_length=200)
    limit: int = Field(default=20, ge=1, le=20)
    page: int = Field(default=1, ge=1, le=10)
    timeout_seconds: float = Field(default=8.0, ge=1.0, le=30.0)


class VideoSearchResult(BaseModel):
    bvid: str
    aid: str | None = None
    title: str
    description: str | None = None
    creator_mid: str | None = None
    creator_name: str | None = None
    cover_url: str | None = None
    duration_seconds: int | None = None
    pub_time: str | None = None
    source_url: str
    category: str | None = None
    tags: list[str] = Field(default_factory=list)


class VideoSearchResponse(BaseModel):
    provider: Literal["kernel_bilibili"]
    profile_id: str
    logged_in: bool
    results: list[VideoSearchResult]
    has_next_page: bool = False
    total_pages: int | None = None


class VideoResolveRequest(BaseModel):
    external_owner_id: str = Field(min_length=1, max_length=128)
    profile_id: str
    bvid: str = Field(min_length=12, max_length=32)


class VideoResolveResponse(VideoSearchResult):
    provider: Literal["kernel_bilibili"]
    profile_id: str
    logged_in: bool
    pages: list[dict[str, object]] = Field(default_factory=list)


class StrategyListResponse(BaseModel):
    strategies: list[str] = Field(default_factory=lambda: list(StrategyName.ALL))
    default_order: list[str] = Field(default_factory=lambda: list(StrategyName.ALL))


class StrategyMetric(BaseModel):
    strategy_name: str
    total_attempts: int
    success_count: int
    fail_count: int
    last_success_at: str | None = None
    last_failure_at: str | None = None
    last_failure_reason: str | None = None
    avg_duration_ms: float


class StrategyMetricsResponse(BaseModel):
    metrics: list[StrategyMetric]


class HealthResponse(BaseModel):
    status: Literal["ok"]
