from __future__ import annotations

from dataclasses import dataclass

from .models import StrategyMode, StrategyName


DEFAULT_STRATEGY_ORDER = [
    StrategyName.API_DASH,
    StrategyName.BROWSER_NETWORK,
    StrategyName.MSE_SOURCEBUFFER,
]


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


def _normalize_order(order: list[str] | None, available: set[str]) -> list[str]:
    result: list[str] = []
    for name in order or DEFAULT_STRATEGY_ORDER:
        if name in available and name not in result:
            result.append(name)
    for name in DEFAULT_STRATEGY_ORDER:
        if name in available and name not in result:
            result.append(name)
    return result


def _score_strategy(
    name: str,
    base_rank: int,
    metric: StrategyMetricSnapshot,
    logged_in: bool,
    context_hints: dict[str, object],
) -> float:
    score = -base_rank * 10.0
    score += metric.success_rate * 8.0
    score -= min(metric.avg_duration_ms / 10_000.0, 5.0)
    if metric.last_failure_reason:
        score -= 1.5
    if name in {StrategyName.BROWSER_NETWORK, StrategyName.MSE_SOURCEBUFFER}:
        score += 2.0 if logged_in else -3.0
    if context_hints.get("prefer_browser") and name == StrategyName.BROWSER_NETWORK:
        score += 4.0
    if context_hints.get("avoid_mse") and name == StrategyName.MSE_SOURCEBUFFER:
        score -= 4.0
    return score


def select_strategy_order(
    strategy_mode: str,
    requested_strategy: str | None,
    strategy_order: list[str] | None,
    available_strategies: list[str] | None = None,
    metrics: dict[str, StrategyMetricSnapshot] | None = None,
    logged_in: bool = False,
    context_hints: dict[str, object] | None = None,
) -> list[str]:
    available = set(available_strategies or DEFAULT_STRATEGY_ORDER)
    if strategy_mode == StrategyMode.FORCE:
        if not requested_strategy:
            raise ValueError("force mode requires strategy")
        if requested_strategy not in available:
            raise ValueError(f"unknown strategy: {requested_strategy}")
        return [requested_strategy]

    if strategy_mode != StrategyMode.AUTO:
        raise ValueError(f"unknown strategy_mode: {strategy_mode}")

    base_order = _normalize_order(strategy_order, available)
    metric_map = metrics or {}
    hints = context_hints or {}
    scored = [
        (
            _score_strategy(
                name,
                rank,
                metric_map.get(name, StrategyMetricSnapshot(strategy_name=name)),
                logged_in,
                hints,
            ),
            rank,
            name,
        )
        for rank, name in enumerate(base_order)
    ]
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [name for _score, _rank, name in scored]
