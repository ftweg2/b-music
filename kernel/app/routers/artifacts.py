from __future__ import annotations

from email.utils import parsedate_to_datetime

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response

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
    request: Request,
    external_owner_id: str = Query(..., min_length=1, max_length=128),
) -> Response:
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
    response = FileResponse(path, filename=path.name, headers=headers, stat_result=path.stat())
    # FileResponse implements ranges and If-Range, but not cache validation.
    # Authorization and artifact existence must be checked before returning 304.
    etag = response.headers.get("etag", "")
    validators = request.headers.get("if-none-match")
    unchanged = False
    if validators is not None:
        unchanged = any(tag.strip().removeprefix("W/") in ("*", etag) for tag in validators.split(","))
    elif modified_since := request.headers.get("if-modified-since"):
        try:
            since = parsedate_to_datetime(modified_since)
            modified = parsedate_to_datetime(response.headers["last-modified"])
            unchanged = since.tzinfo is not None and modified <= since
        except (ValueError, TypeError, OverflowError):
            pass
    if unchanged:
        return Response(status_code=304, headers={
            key: value for key, value in response.headers.items()
            if key not in {"content-length", "content-type", "content-disposition"}
        })
    return response
