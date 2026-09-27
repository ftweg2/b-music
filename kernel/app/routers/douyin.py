from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from app.config import get_settings
from app.douyin.covers import AWEME_ID_RE, IMAGE_TYPES, cover_path, store_cover
from app.douyin.detail import DouyinUnavailable, fetch_aweme_detail, resolve_short_link
from app.douyin.links import canonical_video_url, parse_douyin_url
from app.profile_manager import ProfileNotFoundError, ProfileOwnershipError, verify_profile_owner
from app.routers import jobs as job_routes
from app.schemas import DouyinResolveRequest, DouyinResolveResponse
from app.security import sanitize_text, validate_external_owner_id


router = APIRouter(prefix="/v1/douyin", tags=["douyin"])

_STATUS_FOR_FAILURE = {
    "DOUYIN_LINK_UNRESOLVED": 400,
    "DOUYIN_ITEM_UNAVAILABLE": 404,
    "DOUYIN_DETAIL_TIMEOUT": 504,
    "DOUYIN_BUSY": 503,
    "DOUYIN_BROWSER_CRASHED": 503,
}


@router.post("/resolve", response_model=DouyinResolveResponse)
async def resolve_douyin(request: DouyinResolveRequest) -> dict[str, object]:
    """Read public metadata for one user-supplied Douyin link. No login is used."""
    settings = get_settings()
    try:
        verify_profile_owner(request.profile_id, request.external_owner_id, settings)
        ref = parse_douyin_url(request.url)
        if ref is None:
            raise ValueError("url must be a Douyin video link")
        if job_routes.heavy_work_in_progress() >= settings.max_active_jobs:
            raise DouyinUnavailable("DOUYIN_BUSY", "the kernel is busy with another extraction; retry shortly")
        with job_routes.lookup_admission():
            aweme_id = ref.aweme_id or await resolve_short_link(ref.canonical_url, settings)
            aweme = await fetch_aweme_detail(aweme_id, settings)
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except ProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="profile not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc
    except DouyinUnavailable as exc:
        status = _STATUS_FOR_FAILURE.get(exc.failure_code, 502)
        headers = {"Retry-After": "3"} if exc.failure_code == "DOUYIN_BUSY" else None
        raise HTTPException(
            status_code=status,
            detail=f"{exc.failure_code}: {sanitize_text(exc.reason)}",
            headers=headers,
        ) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Douyin page could not be loaded: {sanitize_text(exc, 300)}") from exc

    try:
        has_cover = await store_cover(aweme, settings)
    except Exception:
        # A missing cover must never fail the lookup; clients show a placeholder.
        has_cover = False
    music = aweme.music
    return {
        "provider": "kernel_douyin",
        "profile_id": request.profile_id,
        "aweme_id": aweme.aweme_id,
        "source_url": canonical_video_url(aweme.aweme_id),
        "title": sanitize_text(aweme.desc, 500) or f"抖音作品 {aweme.aweme_id}",
        "creator_name": aweme.author,
        "duration_seconds": aweme.duration_seconds,
        "music_title": music.title if music else None,
        "music_author": music.author if music else None,
        "has_music_audio": bool(aweme.music_urls),
        "has_video_audio": bool(aweme.video_urls),
        "has_cover": has_cover,
    }


@router.get("/covers/{aweme_id}")
def get_douyin_cover(
    aweme_id: str,
    external_owner_id: str = Query(..., min_length=1, max_length=128),
) -> FileResponse:
    """Serve a cover cached by an earlier resolve. Covers are public item images."""
    try:
        validate_external_owner_id(external_owner_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc
    if not AWEME_ID_RE.fullmatch(aweme_id):
        raise HTTPException(status_code=400, detail="aweme_id must be a Douyin item id")
    path = cover_path(aweme_id, get_settings())
    if path is None:
        raise HTTPException(status_code=404, detail="cover not cached")
    return FileResponse(
        path,
        media_type=IMAGE_TYPES[path.suffix],
        headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"},
    )
