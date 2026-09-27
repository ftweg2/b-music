"""Bilibili's first-party web QR flow, using the kernel profile's cookie jar.

The endpoints and state codes are used by passport.bilibili.com/login itself.
Only a PNG leaves the kernel: challenge keys, callback URLs and cookies never do.
No page navigation, screenshot, CAPTCHA solver or background QR replacement.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import re
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from playwright.async_api import Error as BrowserError, TimeoutError as BrowserTimeout
import qrcode
from qrcode.image.pure import PyPNGImage

from app.config import Settings


class LoginFlowError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 502, retryable: bool = True):
        super().__init__(message)
        self.code, self.status, self.retryable = code, status, retryable


@dataclass(frozen=True)
class QRChallenge:
    key: str = field(repr=False)


async def _request(context: Any, path: str, settings: Settings, params: dict | None = None) -> dict:
    response = None
    try:
        async with asyncio.timeout(min(settings.request_timeout_seconds, 12)):
            response = await context.request.get(
                "https://passport.bilibili.com" + path,
                params=params or {},
                headers={"user-agent": settings.bilibili_user_agent, "referer": "https://passport.bilibili.com/login"},
                timeout=min(settings.request_timeout_seconds, 10) * 1000,
                max_redirects=0,
            )
            if response.status in (403, 412, 429):
                raise LoginFlowError("LOGIN_UPSTREAM_RESTRICTED", "B 站暂时限制了登录请求，请稍后重试；如需验证，请在 B 站完成。", 503, False)
            if response.status != 200:
                raise LoginFlowError("LOGIN_UPSTREAM_UNAVAILABLE", "暂时无法连接 B 站登录服务，请稍后重试。")
            raw = await response.body()
            if len(raw) > 64 * 1024:
                raise ValueError("oversized response")
            payload = json.loads(raw)
            if not isinstance(payload, dict) or payload.get("code") != 0 or not isinstance(payload.get("data"), dict):
                raise LoginFlowError("LOGIN_UPSTREAM_REJECTED", "B 站未接受本次登录请求，请稍后重试。", 502, False)
            return payload["data"]
    except (TimeoutError, BrowserTimeout) as exc:
        raise LoginFlowError("LOGIN_UPSTREAM_TIMEOUT", "连接 B 站登录服务超时，请稍后重试。", 504) from exc
    except BrowserError as exc:
        # APIRequestContext in Playwright 1.49 may use Error (not its
        # TimeoutError subclass) for transport deadlines. Never expose its
        # call log, which can contain the private challenge query string.
        if re.search(r"\b(?:Timeout \d+ms exceeded|Request timed out after \d+ms)\b", str(exc)):
            raise LoginFlowError("LOGIN_UPSTREAM_TIMEOUT", "连接 B 站登录服务超时，请稍后重试。", 504) from exc
        raise LoginFlowError("LOGIN_UPSTREAM_UNAVAILABLE", "B 站登录连接中断，请稍后重试。") from exc
    except (ValueError, TypeError) as exc:
        raise LoginFlowError("LOGIN_INVALID_RESPONSE", "B 站登录服务返回了无效响应，请稍后重试。") from exc
    finally:
        if response is not None:
            # Playwright otherwise retains every response body until context close.
            with contextlib.suppress(Exception):
                async with asyncio.timeout(2):
                    await response.dispose()


async def create_qr(context: Any, path: Path, settings: Settings) -> QRChallenge:
    data = await _request(context, "/x/passport-login/web/qrcode/generate", settings, {"source": "main_web"})
    key, url = data.get("qrcode_key"), data.get("url")
    if not isinstance(key, str) or not key or len(key) > 256 or not isinstance(url, str) or len(url) > 4096:
        raise LoginFlowError("LOGIN_INVALID_QR", "B 站未返回有效二维码，请重新发起登录。")
    try:
        target = urlsplit(url)
        valid = (target.scheme == "https" and target.hostname == "account.bilibili.com"
                 and target.port in (None, 443) and not target.username and not target.password)
    except ValueError:
        valid = False
    if not valid:
        raise LoginFlowError("LOGIN_INVALID_QR", "B 站返回的二维码地址无效，请重新发起登录。", 502, False)
    # Pure Python PNG encoding; no browser rasterization or native image dependency.
    code = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=6, border=4)
    code.add_data(url)
    code.make(fit=True)
    image = BytesIO()
    code.make_image(image_factory=PyPNGImage).save(image)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(image.getvalue())
    path.chmod(0o600)
    return QRChallenge(key)


async def poll_qr(context: Any, challenge: QRChallenge, settings: Settings) -> str:
    data = await _request(context, "/x/passport-login/web/qrcode/poll", settings,
                          {"qrcode_key": challenge.key, "source": "main_web"})
    states = {86101: "waiting_scan", 86090: "waiting_confirm", 86038: "expired", 0: "confirmed"}
    code = data.get("code")
    state = states.get(code) if type(code) is int else None
    if state is None:
        raise LoginFlowError("LOGIN_UPSTREAM_REJECTED", "B 站未接受本次扫码，请重新发起登录。", 502, False)
    # Set-Cookie from the poll response is already in BrowserContext.request's
    # shared jar. A separately verified /nav identity is required before success.
    return state
