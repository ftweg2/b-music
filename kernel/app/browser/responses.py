"""Release consumed Playwright API bodies while preserving the caller's result."""
from __future__ import annotations

import asyncio
import contextlib
from contextlib import asynccontextmanager


async def dispose_response(response: object | None) -> None:
    dispose = getattr(response, "dispose", None)
    if dispose is not None:
        with contextlib.suppress(Exception):
            async with asyncio.timeout(2):
                await dispose()


@asynccontextmanager
async def managed_response(response: object):
    try:
        yield response
    finally:
        await dispose_response(response)
