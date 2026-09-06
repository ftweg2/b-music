"""Blocking work with cancellation that drains the worker before releasing owners."""
from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from threading import Event
from typing import TypeVar

T = TypeVar("T")


async def run_blocking(operation: Callable[[Event], T]) -> T:
    stop = Event()
    task = asyncio.create_task(asyncio.to_thread(operation, stop))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        stop.set()
        # A thread cannot be killed by cancelling its asyncio wrapper. Keep the
        # owner alive until it exits, including after repeated cancel requests.
        while not task.done():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.shield(task)
        with contextlib.suppress(BaseException):
            task.result()
        raise
