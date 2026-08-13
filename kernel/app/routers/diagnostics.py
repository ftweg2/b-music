from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, HTTPException

from app.config import get_settings
from app.job_manager import cleanup_old_artifacts, diagnostics
from app.security import sanitize_text


router = APIRouter(prefix="/v1/diagnostics", tags=["diagnostics"])


def require_operator_token(
    x_kernel_operator_token: str | None = Header(default=None),
) -> None:
    expected = get_settings().operator_token
    if not expected:
        raise HTTPException(status_code=503, detail="operator diagnostics are disabled")
    if not x_kernel_operator_token or not hmac.compare_digest(x_kernel_operator_token, expected):
        raise HTTPException(status_code=403, detail="operator authorization failed")


@router.get("")
def get_diagnostics(_authorized: None = Depends(require_operator_token)) -> dict[str, object]:
    try:
        return diagnostics()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=sanitize_text(exc)) from exc


@router.post("/cleanup/artifacts")
def cleanup_artifacts(_authorized: None = Depends(require_operator_token)) -> dict[str, int]:
    try:
        return cleanup_old_artifacts()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=sanitize_text(exc)) from exc
