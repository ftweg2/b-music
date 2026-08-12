from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException

from app.job_manager import (
    JobConflictError,
    JobNotFoundError,
    create_job,
    get_job_status,
    request_cancel,
    run_job,
)
from app.profile_manager import ProfileLockedError, ProfileNotFoundError, ProfileOwnershipError
from app.schemas import CancelResponse, JobCreateRequest, JobCreateResponse, JobStatusResponse
from app.security import sanitize_text


router = APIRouter(prefix="/v1/jobs", tags=["jobs"])
_job_tasks: set[asyncio.Task[None]] = set()


@router.post("", response_model=JobCreateResponse)
async def submit_job(request: JobCreateRequest) -> dict[str, str]:
    try:
        response = create_job(request)
    except JobConflictError as exc:
        raise HTTPException(status_code=409, detail=sanitize_text(exc)) from exc
    except ProfileLockedError as exc:
        raise HTTPException(status_code=409, detail=sanitize_text(exc)) from exc
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except ProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="profile not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc

    task = asyncio.create_task(run_job(request.job_id))
    _job_tasks.add(task)
    task.add_done_callback(_job_tasks.discard)
    return response


@router.get("/{job_id}", response_model=JobStatusResponse)
def get_job(job_id: str) -> dict[str, object]:
    try:
        return get_job_status(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc


@router.post("/{job_id}/cancel", response_model=CancelResponse)
def cancel_job(job_id: str) -> dict[str, str]:
    try:
        return request_cancel(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc
