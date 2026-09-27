from __future__ import annotations

from fastapi import APIRouter

from app.job_manager import strategy_metrics
from app.models import StrategyName
from app.schemas import StrategyListResponse, StrategyMetricsResponse
from app.strategy_selector import DEFAULT_STRATEGY_ORDER, SOURCE_STRATEGY_ORDER


router = APIRouter(prefix="/v1/strategies", tags=["strategies"])


@router.get("", response_model=StrategyListResponse)
def list_strategies() -> dict[str, object]:
    return {
        "strategies": list(StrategyName.ALL),
        "default_order": list(DEFAULT_STRATEGY_ORDER),
        "source_orders": {source: list(order) for source, order in SOURCE_STRATEGY_ORDER.items()},
    }


@router.get("/metrics", response_model=StrategyMetricsResponse)
def get_strategy_metrics() -> dict[str, object]:
    return {"metrics": strategy_metrics()}
