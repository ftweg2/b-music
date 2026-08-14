from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import init_db
from app.job_manager import cleanup_old_artifacts, recover_interrupted_runtime
from app.profile_manager import recover_stale_login_sessions, shutdown_login_runtimes
from app.routers import artifacts, diagnostics, jobs, profiles, search, strategies, videos
from app.schemas import HealthResponse


settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.ensure_dirs()
    init_db(settings)
    recover_interrupted_runtime(settings)
    recover_stale_login_sessions(settings)
    cleanup_old_artifacts(settings)
    try:
        yield
    finally:
        await jobs.shutdown_job_tasks()
        await shutdown_login_runtimes()


app = FastAPI(
    title="bili-ctf-audio-kernel",
    version="1.2.0",
    description="Kernel-only authorized Bilibili CTF audio extraction service.",
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
