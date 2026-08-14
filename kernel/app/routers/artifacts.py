from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from app.job_manager import JobNotFoundError, artifact_path, list_artifacts, verify_job_owner
from app.profile_manager import ProfileOwnershipError
from app.schemas import ArtifactListResponse
from app.security import sanitize_text


router = APIRouter(prefix="/v1/jobs", tags=["artifacts"])


@router.get("/{job_id}/artifacts", response_model=ArtifactListResponse)
def get_artifacts(
    job_id: str,
    external_owner_id: str = Query(..., min_length=1, max_length=128),
) -> dict[str, object]:
    try:
        verify_job_owner(job_id, external_owner_id)
        return {"job_id": job_id, "artifacts": list_artifacts(job_id)}
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc


@router.api_route("/{job_id}/artifacts/{name}", methods=["GET", "HEAD"])
def download_artifact(
    job_id: str,
    name: str,
    external_owner_id: str = Query(..., min_length=1, max_length=128),
) -> FileResponse:
    try:
        verify_job_owner(job_id, external_owner_id)
        path = artifact_path(job_id, name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="artifact not found") from exc
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc
    artifact = next(
        (item for item in list_artifacts(job_id) if item["name"] == path.name),
        None,
    )
    headers: dict[str, str] = {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
    }
    if artifact is not None:
        headers["X-Content-SHA256"] = str(artifact["sha256"])
        headers["X-File-Size"] = str(artifact["size_bytes"])
        headers["ETag"] = f'"sha256-{artifact["sha256"]}"'
    return FileResponse(path, filename=path.name, headers=headers)
