from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException

from app.bilibili.bvid import parse_bvid
from app.bilibili.metadata import BilibiliApiError, resolve_video_metadata
from app.config import get_settings
from app.models import LoginStatus
from app.profile_manager import ProfileNotFoundError, ProfileOwnershipError, verify_profile_owner
from app.schemas import VideoResolveRequest, VideoResolveResponse
from app.security import sanitize_text


router = APIRouter(prefix="/v1/videos", tags=["videos"])


@router.post("/resolve", response_model=VideoResolveResponse)
async def resolve_video(request: VideoResolveRequest) -> dict[str, object]:
    settings = get_settings()
    try:
        profile = verify_profile_owner(request.profile_id, request.external_owner_id, settings)
        bvid = parse_bvid(request.bvid)
        if not bvid:
            raise ValueError("bvid must be a valid Bilibili BV id")
        async with httpx.AsyncClient(timeout=httpx.Timeout(settings.request_timeout_seconds)) as client:
            metadata = await resolve_video_metadata(client, bvid, settings.bilibili_user_agent)
        metadata["provider"] = "kernel_bilibili"
        metadata["profile_id"] = request.profile_id
        metadata["logged_in"] = profile.get("login_status") == LoginStatus.LOGGED_IN
        return metadata
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except ProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="profile not found") from exc
    except (BilibiliApiError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=sanitize_text(exc)) from exc
