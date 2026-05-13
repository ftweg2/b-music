from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.job_manager import cleanup_old_artifacts, diagnostics
from app.security import sanitize_text


router = APIRouter(prefix="/v1/diagnostics", tags=["diagnostics"])


@router.get("")
def get_diagnostics() -> dict[str, object]:
    try:
        return diagnostics()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=sanitize_text(exc)) from exc


@router.post("/cleanup/artifacts")
def cleanup_artifacts() -> dict[str, int]:
    try:
        return cleanup_old_artifacts()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=sanitize_text(exc)) from exc
