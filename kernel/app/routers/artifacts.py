from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.job_manager import JobNotFoundError, artifact_path, list_artifacts
from app.schemas import ArtifactListResponse
from app.security import sanitize_text


router = APIRouter(prefix="/v1/jobs", tags=["artifacts"])


@router.get("/{job_id}/artifacts", response_model=ArtifactListResponse)
def get_artifacts(job_id: str) -> dict[str, object]:
    try:
        return {"job_id": job_id, "artifacts": list_artifacts(job_id)}
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc


@router.get("/{job_id}/artifacts/{name}")
def download_artifact(job_id: str, name: str) -> FileResponse:
    try:
        path = artifact_path(job_id, name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="artifact not found") from exc
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc
    return FileResponse(path, filename=path.name)
