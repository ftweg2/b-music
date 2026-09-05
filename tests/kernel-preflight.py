"""Read-only deployment check; run inside the target kernel container via stdin."""
import json
from app.config import get_settings
from app.db import get_connection

settings = get_settings()
with get_connection(settings) as conn:
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    print(json.dumps({
        "active_jobs": conn.execute("SELECT COUNT(*) FROM jobs WHERE status NOT IN ('succeeded','failed','cancelled')").fetchone()[0],
        "profile_locks": conn.execute("SELECT COUNT(*) FROM profiles WHERE active_job_id IS NOT NULL AND active_job_id!=''").fetchone()[0],
        "profile_readers": conn.execute("SELECT COUNT(*) FROM profile_readers").fetchone()[0] if "profile_readers" in tables else 0,
        "logged_in_profiles": conn.execute("SELECT COUNT(*) FROM profiles WHERE login_status='logged_in'").fetchone()[0],
    }))
