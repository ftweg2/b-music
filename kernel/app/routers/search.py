from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.bilibili.search import KernelSearchError, search_videos_with_profile
from app.profile_manager import ProfileLockedError, ProfileNotFoundError, ProfileOwnershipError
from app.schemas import VideoSearchRequest, VideoSearchResponse
from app.security import sanitize_text


router = APIRouter(prefix="/v1/search", tags=["search"])


@router.post("/videos", response_model=VideoSearchResponse)
async def search_videos(request: VideoSearchRequest) -> dict[str, object]:
    try:
        return await search_videos_with_profile(
            external_owner_id=request.external_owner_id,
            profile_id=request.profile_id,
            keyword=request.keyword,
            limit=request.limit,
            page=request.page,
            timeout_seconds=request.timeout_seconds,
        )
    except ProfileLockedError as exc:
        raise HTTPException(status_code=409, detail=sanitize_text(exc), headers={"Retry-After": "2"}) from exc
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except ProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="profile not found") from exc
    except KernelSearchError as exc:
        raise HTTPException(status_code=exc.status_code, detail=sanitize_text(exc), headers={"Retry-After": str(exc.retry_after)} if exc.retry_after else None) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=sanitize_text(exc)) from exc
