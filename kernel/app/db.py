from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from collections.abc import Iterator
from pathlib import Path

from .config import Settings, get_settings


SCHEMA_SQL = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS profiles (
    profile_id TEXT PRIMARY KEY,
    external_owner_id TEXT NOT NULL UNIQUE,
    login_status TEXT NOT NULL DEFAULT 'unknown',
    bili_uid TEXT,
    nickname TEXT,
    last_verified_at TEXT,
    active_job_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_sessions (
    login_session_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(profile_id) REFERENCES profiles(profile_id)
);

CREATE TABLE IF NOT EXISTS profile_readers (
    lease_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(profile_id) REFERENCES profiles(profile_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_readers_profile ON profile_readers(profile_id);

CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    external_owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    url TEXT NOT NULL,
    strategy_mode TEXT NOT NULL,
    strategy TEXT,
    strategy_order_json TEXT,
    outputs_json TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    selected_strategy TEXT,
    sanitized_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(profile_id) REFERENCES profiles(profile_id)
);

CREATE TABLE IF NOT EXISTS strategy_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    strategy_name TEXT NOT NULL,
    status TEXT NOT NULL,
    failure_code TEXT,
    reason TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    sanitized_debug_info_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(job_id) REFERENCES jobs(job_id)
);

CREATE TABLE IF NOT EXISTS strategy_metrics (
    strategy_name TEXT PRIMARY KEY,
    total_attempts INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_success_at TEXT,
    last_failure_at TEXT,
    last_failure_reason TEXT,
    avg_duration_ms REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    producer_strategy TEXT NOT NULL,
    mime_guess TEXT,
    UNIQUE(job_id, name),
    FOREIGN KEY(job_id) REFERENCES jobs(job_id)
);
"""


@contextmanager
def get_connection(settings: Settings | None = None) -> Iterator[sqlite3.Connection]:
    settings = settings or get_settings()
    settings.ensure_dirs()
    conn = sqlite3.connect(settings.db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=NORMAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    settings.ensure_dirs()
    with get_connection(settings) as conn:
        conn.executescript(SCHEMA_SQL)


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
