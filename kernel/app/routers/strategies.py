from __future__ import annotations

from fastapi import APIRouter

from app.job_manager import strategy_metrics
from app.models import StrategyName
from app.schemas import StrategyListResponse, StrategyMetricsResponse


router = APIRouter(prefix="/v1/strategies", tags=["strategies"])


@router.get("", response_model=StrategyListResponse)
def list_strategies() -> dict[str, list[str]]:
    return {"strategies": list(StrategyName.ALL), "default_order": list(StrategyName.ALL)}


@router.get("/metrics", response_model=StrategyMetricsResponse)
def get_strategy_metrics() -> dict[str, object]:
    return {"metrics": strategy_metrics()}
