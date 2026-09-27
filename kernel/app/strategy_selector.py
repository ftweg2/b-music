from __future__ import annotations

from dataclasses import dataclass

from .models import SourceName, StrategyMode, StrategyName


# Each source has its own strategies. A strategy never runs against a source it
# was not written for, even when a client lists it explicitly.
SOURCE_STRATEGY_ORDER = {
    SourceName.BILIBILI: [
        StrategyName.API_DASH,
        StrategyName.BROWSER_NETWORK,
        StrategyName.MSE_SOURCEBUFFER,
    ],
    SourceName.DOUYIN: [
        StrategyName.DOUYIN_MUSIC,
    ],
}

DEFAULT_STRATEGY_ORDER = SOURCE_STRATEGY_ORDER[SourceName.BILIBILI]


@dataclass(frozen=True)
class StrategyMetricSnapshot:
    strategy_name: str
    total_attempts: int = 0
    success_count: int = 0
    fail_count: int = 0
    last_failure_reason: str | None = None
    avg_duration_ms: float = 0

    @property
    def success_rate(self) -> float:
        if self.total_attempts <= 0:
            return 0.0
        return self.success_count / self.total_attempts


def select_strategy_order(
    strategy_mode: str,
    requested_strategy: str | None,
    strategy_order: list[str] | None,
    available_strategies: list[str] | None = None,
    metrics: dict[str, StrategyMetricSnapshot] | None = None,
    logged_in: bool = False,
    context_hints: dict[str, object] | None = None,
    source: str = SourceName.BILIBILI,
) -> list[str]:
    source_order = SOURCE_STRATEGY_ORDER.get(source)
    if source_order is None:
        raise ValueError(f"unknown source: {source}")
    available = set(source_order if available_strategies is None else available_strategies)
    if strategy_mode == StrategyMode.FORCE:
        if not requested_strategy:
            raise ValueError("force mode requires strategy")
        _require_source_support(requested_strategy, source, source_order)
        if requested_strategy not in available:
            raise ValueError(f"unknown strategy: {requested_strategy}")
        return [requested_strategy]

    if strategy_mode != StrategyMode.AUTO:
        raise ValueError(f"unknown strategy_mode: {strategy_mode}")

    # Metrics remain diagnostic data; they must never override the requested sequence.
    # An explicit list is an allowlist: omitted experimental strategies stay omitted.
    requested = [name for name in source_order if name in available] if strategy_order is None else strategy_order
    if not requested:
        raise ValueError("strategy_order must not be empty")
    result: list[str] = []
    for name in requested:
        _require_source_support(name, source, source_order)
        if name not in available:
            raise ValueError(f"unavailable strategy: {name}")
        if name not in result:
            result.append(name)
    return result


def _require_source_support(name: str, source: str, source_order: list[str]) -> None:
    if name in StrategyName.ALL and name not in source_order:
        raise ValueError(f"strategy {name} does not support {source} sources")
