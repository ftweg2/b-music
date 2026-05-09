from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import init_db
from app.routers import artifacts, jobs, profiles, search, strategies
from app.schemas import HealthResponse


app = FastAPI(
    title="bili-ctf-audio-kernel",
    version="0.1.0",
    description="Kernel-only authorized Bilibili CTF audio extraction service.",
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["content-type"],
)


@app.on_event("startup")
def startup() -> None:
    settings.ensure_dirs()
    init_db(settings)


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
