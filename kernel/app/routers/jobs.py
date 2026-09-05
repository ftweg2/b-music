from __future__ import annotations

import asyncio
import logging

from app.config import get_settings

from fastapi import APIRouter, HTTPException, Query

from app.job_manager import (
    JobConflictError,
    JobNotFoundError,
    create_job,
    get_job_status,
    request_cancel,
    run_job,
    verify_job_owner,
)
from app.profile_manager import ProfileLockedError, ProfileNotFoundError, ProfileOwnershipError
from app.schemas import (
    CancelResponse,
    JobAccessRequest,
    JobCreateRequest,
    JobCreateResponse,
    JobStatusResponse,
)
from app.security import sanitize_text


router = APIRouter(prefix="/v1/jobs", tags=["jobs"])
_job_tasks: set[asyncio.Task[None]] = set()


def _consume_task_result(task: asyncio.Task[None]) -> None:
    _job_tasks.discard(task)
    if task.cancelled():
        return
    task.exception()


async def shutdown_job_tasks() -> None:
    tasks = list(_job_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        _done, pending = await asyncio.wait(tasks, timeout=get_settings().shutdown_grace_seconds)
        for task in pending:
            task.cancel()
        if pending:
            logging.getLogger(__name__).warning("%d job tasks exceeded shutdown grace", len(pending))
    # Done callbacks remove tasks. Never clear live tasks before their cleanup has run.


@router.post("", response_model=JobCreateResponse)
async def submit_job(request: JobCreateRequest) -> dict[str, object]:
    try:
        if len(_job_tasks) >= get_settings().max_active_jobs:
            try:
                verify_job_owner(request.job_id, request.external_owner_id)
            except JobNotFoundError:
                raise HTTPException(status_code=503, detail="kernel is busy; retry later", headers={"Retry-After": "3", "X-Kernel-Job-Accepted": "false"})
        response = create_job(request)
    except JobConflictError as exc:
        raise HTTPException(status_code=409, detail=sanitize_text(exc)) from exc
    except ProfileLockedError as exc:
        raise HTTPException(status_code=409, detail=sanitize_text(exc), headers={"Retry-After": "2", "X-Kernel-Job-Accepted": "false"}) from exc
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except ProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="profile not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc

    if response.get("reused"):
        return response
    task = asyncio.create_task(run_job(request.job_id), name="kernel-job:" + request.job_id)
    _job_tasks.add(task)
    task.add_done_callback(_consume_task_result)
    return response


@router.get("/{job_id}", response_model=JobStatusResponse)
def get_job(
    job_id: str,
    external_owner_id: str = Query(..., min_length=1, max_length=128),
) -> dict[str, object]:
    try:
        verify_job_owner(job_id, external_owner_id)
        return get_job_status(job_id)
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc


@router.post("/{job_id}/cancel", response_model=CancelResponse)
async def cancel_job(job_id: str, request: JobAccessRequest) -> dict[str, str]:
    try:
        verify_job_owner(job_id, request.external_owner_id)
        status = get_job_status(job_id)["status"]
        response = request_cancel(job_id)
        # Let queued runners start and observe the flag; cancelling an unstarted coroutine
        # would skip its finally block and leak the profile lock.
        if response["status"] == "cancel_requested" and status != "queued":
            for task in list(_job_tasks):
                if task.get_name() == "kernel-job:" + job_id:
                    task.cancel()
        return response
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc
