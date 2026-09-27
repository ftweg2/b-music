from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import init_db
from app.job_manager import cleanup_old_artifacts, recover_interrupted_runtime
from app.profile_manager import recover_stale_login_sessions, shutdown_login_runtimes
from app.routers import artifacts, diagnostics, douyin, jobs, profiles, search, strategies, videos
from app.schemas import HealthResponse
from app.security import sanitize_text
from app.browser.context_manager import shutdown_browser_contexts


settings = get_settings()
logger = logging.getLogger(__name__)
ARTIFACT_CLEANUP_INTERVAL_SECONDS = 3600


async def _cleanup_artifacts_periodically() -> None:
    # A long-running kernel keeps removing expired artifacts, so disk use stays
    # bounded without a restart (the host guard stops B-Music on low disk).
    while True:
        await asyncio.sleep(ARTIFACT_CLEANUP_INTERVAL_SECONDS)
        try:
            await asyncio.to_thread(cleanup_old_artifacts, settings)
        except Exception as exc:
            logger.warning("Periodic artifact cleanup failed: %s", sanitize_text(exc))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.ensure_dirs()
    init_db(settings)
    recover_interrupted_runtime(settings)
    recover_stale_login_sessions(settings)
    cleanup_old_artifacts(settings)
    cleanup_task = asyncio.create_task(_cleanup_artifacts_periodically(), name="kernel-artifact-cleanup")
    try:
        yield
    finally:
        cleanup_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await cleanup_task
        await jobs.shutdown_job_tasks()
        await shutdown_login_runtimes()
        await shutdown_browser_contexts()


app = FastAPI(
    title="bili-ctf-audio-kernel",
    version="1.2.0",
    description="Kernel-only authorized Bilibili CTF and public Douyin audio extraction service.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["content-type"],
)


@app.get("/")
def service_info() -> dict[str, str]:
    return {
        "service": "bili-ctf-audio-kernel",
        "status": "ok",
        "health": "/health",
        "docs": "/docs",
    }


@app.get("/health", response_model=HealthResponse)
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/healthz", response_model=HealthResponse)
def healthz() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(profiles.router)
app.include_router(jobs.router)
app.include_router(artifacts.router)
app.include_router(search.router)
app.include_router(strategies.router)
app.include_router(diagnostics.router)
app.include_router(videos.router)
app.include_router(douyin.router)
