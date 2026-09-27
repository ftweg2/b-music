"""Use the profile's existing cookie owner for small Bilibili API responses."""
from __future__ import annotations

from contextlib import asynccontextmanager

import httpx
from playwright.async_api import Error as PlaywrightError, TimeoutError as PlaywrightTimeoutError

from app.browser.context_manager import BrowserContextManager
from app.browser.responses import managed_response
from app.config import Settings


class _ProfileApiTransport(httpx.AsyncBaseTransport):
    def __init__(self, request_context: object, timeout_ms: int) -> None:
        self._request_context = request_context
        self._timeout_ms = timeout_ms

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        # Media must use the streaming downloader, not Playwright's buffered API.
        if (request.method != "GET" or request.url.scheme != "https"
                or request.url.host != "api.bilibili.com"):
            raise httpx.UnsupportedProtocol("Profile API transport only supports Bilibili API GETs")
        try:
            response = await self._request_context.get(
                str(request.url),
                headers={key: value for key, value in request.headers.items() if key != "cookie"},
                timeout=self._timeout_ms,
            )
            async with managed_response(response):
                # Set-Cookie is committed by the profile request context. Do not
                # copy it into a second HTTPX cookie jar. Playwright decodes the
                # body, so Content-Encoding/Length must not be copied either.
                return httpx.Response(
                    response.status,
                    content=await response.body() if response.status == 200 else b"",
                    headers={"content-type": response.headers.get("content-type", "application/json")},
                )
        except PlaywrightTimeoutError:
            raise httpx.ReadTimeout("Bilibili profile API request timed out", request=request) from None
        except PlaywrightError:
            raise httpx.TransportError("Bilibili profile API request failed", request=request) from None


@asynccontextmanager
async def open_profile_api_client(profile_id: str, settings: Settings):
    managed = await BrowserContextManager(settings).open_request_context(profile_id)
    try:
        async with httpx.AsyncClient(
            transport=_ProfileApiTransport(managed.context.request, int(settings.request_timeout_seconds * 1000)),
            timeout=settings.request_timeout_seconds,
        ) as client:
            yield client
    finally:
        await managed.close()
