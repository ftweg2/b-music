from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from app.config import Settings
from app.models import StrategyStatus


@dataclass(frozen=True)
class StrategyContext:
    job_id: str
    external_owner_id: str
    profile_id: str
    url: str
    outputs: list[str]
    job_dir: Path
    settings: Settings
    logged_in: bool
    context_hints: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class StrategyResult:
    status: str
    reason: str
    selected_media: dict[str, object] | None = None
    raw_artifacts: list[Path] = field(default_factory=list)
    timings: dict[str, int] = field(default_factory=dict)
    sanitized_debug_info: dict[str, object] = field(default_factory=dict)
    failure_code: str | None = None

    @classmethod
    def succeeded(
        cls,
        *,
        reason: str,
        selected_media: dict[str, object],
        raw_artifacts: list[Path],
        timings: dict[str, int],
        sanitized_debug_info: dict[str, object] | None = None,
    ) -> "StrategyResult":
        return cls(
            status=StrategyStatus.SUCCEEDED,
            reason=reason,
            selected_media=selected_media,
            raw_artifacts=raw_artifacts,
            timings=timings,
            sanitized_debug_info=sanitized_debug_info or {},
        )

    @classmethod
    def failed(
        cls,
        *,
        failure_code: str,
        reason: str,
        timings: dict[str, int] | None = None,
        sanitized_debug_info: dict[str, object] | None = None,
    ) -> "StrategyResult":
        return cls(
            status=StrategyStatus.FAILED,
            reason=reason,
            failure_code=failure_code,
            timings=timings or {},
            sanitized_debug_info=sanitized_debug_info or {},
        )


class ExtractionStrategy(Protocol):
    name: str

    def supports(self, context: StrategyContext) -> bool:
        ...

    async def run(self, context: StrategyContext) -> StrategyResult:
        ...
