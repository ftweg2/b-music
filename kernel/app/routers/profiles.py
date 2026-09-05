from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse

from app.profile_manager import (
    CookieImportError,
    ProfileLockedError,
    ProfileNotFoundError,
    ProfileOwnershipError,
    create_or_get_profile,
    get_login_qr_image_path,
    get_login_status,
    import_cookies_to_profile,
    start_login,
    logout_profile,
    verify_profile_owner,
)
from app.schemas import (
    CookieImportRequest,
    CookieImportResponse,
    LoginStartRequest,
    LoginStartResponse,
    LoginStatusResponse,
    ProfileCreateRequest,
    ProfileCreateResponse,
)
from app.security import sanitize_text


router = APIRouter(prefix="/v1/profiles", tags=["profiles"])


@router.post("/{profile_id}/login/logout", response_model=LoginStatusResponse)
async def login_logout(profile_id: str, request: LoginStartRequest) -> dict[str, object]:
    try:
        return await logout_profile(profile_id, request.external_owner_id)
    except ProfileLockedError as exc:
        raise HTTPException(status_code=409, detail="当前登录资料正在使用或关闭中，请稍后重试", headers={"Retry-After": "2"}) from exc
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail="无权操作这个登录资料") from exc
    except ProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="登录资料不存在") from exc
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail="未能安全清理登录资料，请重试") from exc


@router.post("", response_model=ProfileCreateResponse)
def create_profile(request: ProfileCreateRequest) -> dict[str, str]:
    try:
        return create_or_get_profile(request.external_owner_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc


@router.post("/{profile_id}/login/start", response_model=LoginStartResponse)
async def login_start(
    profile_id: str,
    request: LoginStartRequest = Body(...),
) -> dict[str, object]:
    try:
        return await start_login(profile_id, request.external_owner_id)
    except ProfileLockedError as exc:
        raise HTTPException(status_code=409, detail=sanitize_text(exc), headers={"Retry-After": "2"}) from exc
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except ProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="profile not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=sanitize_text(exc)) from exc


@router.get("/{profile_id}/login/status", response_model=LoginStatusResponse)
def login_status(
    profile_id: str,
    external_owner_id: str = Query(..., min_length=1, max_length=128),
) -> dict[str, object]:
    try:
        verify_profile_owner(profile_id, external_owner_id)
        return get_login_status(profile_id)
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except ProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="profile not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc


@router.get("/{profile_id}/login/{login_session_id}/qr.png")
def login_qr_image(
    profile_id: str,
    login_session_id: str,
    external_owner_id: str = Query(..., min_length=1, max_length=128),
) -> FileResponse:
    try:
        path = get_login_qr_image_path(
            profile_id=profile_id,
            login_session_id=login_session_id,
            external_owner_id=external_owner_id,
        )
        return FileResponse(
            path,
            media_type="image/png",
            headers={"Cache-Control": "no-store"},
        )
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except ProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="login QR not found") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="login QR image not ready") from exc
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc


@router.post("/{profile_id}/cookies/import", response_model=CookieImportResponse)
async def import_profile_cookies(
    profile_id: str,
    request: CookieImportRequest,
) -> dict[str, object]:
    try:
        result = await import_cookies_to_profile(
            profile_id=profile_id,
            external_owner_id=request.external_owner_id,
            format_name=request.format,
            cookies_payload=request.cookies,
        )
        return {
            "profile_id": result.profile_id,
            "status": result.status,
            "logged_in": result.logged_in,
            "bili_uid": result.bili_uid,
            "nickname": result.nickname,
            "last_verified_at": result.last_verified_at,
            "message": result.message,
        }
    except ProfileLockedError as exc:
        raise HTTPException(status_code=409, detail=sanitize_text(exc)) from exc
    except ProfileOwnershipError as exc:
        raise HTTPException(status_code=403, detail=sanitize_text(exc)) from exc
    except ProfileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="profile not found") from exc
    except (CookieImportError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=sanitize_text(exc)) from exc
