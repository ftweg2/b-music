"""Bounded real-upstream QR smoke check using a disposable profile, never user data.

Run inside the prebuilt Linux kernel image with production memory/CPU limits.
It does not scan/confirm a QR or print cookie, QR key, callback URL or identity.
"""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import time

from app.config import get_settings
from app.db import init_db, get_connection
from app import profile_manager as profiles
from app.browser.context_manager import shutdown_browser_contexts


async def run(root):
    settings = replace(get_settings(), data_dir=root, db_path=root / "kernel.sqlite3",
                       profiles_dir=root / "profiles", artifacts_dir=root / "artifacts")
    init_db(settings)
    profile = profiles.create_or_get_profile("isolated-login-probe", settings)["profile_id"]
    timings = []
    try:
        for cycle in range(2):
            start = time.monotonic()
            result = await profiles.start_login(profile, "isolated-login-probe", settings)
            runtime = profiles._LOGIN_RUNTIMES[result["login_session_id"]]
            image = runtime.qr_path.read_bytes()
            assert image.startswith(b"\x89PNG\r\n\x1a\n")
            reused = await profiles.start_login(profile, "isolated-login-probe", settings)
            assert reused["login_session_id"] == result["login_session_id"]
            ready_ms = round((time.monotonic() - start) * 1000)
            await asyncio.sleep(7)
            assert runtime.qr_path.read_bytes() == image
            assert not profiles.get_login_status(profile, settings)["logged_in"]
            runtime.expires_at_monotonic = time.monotonic() - 1
            await asyncio.wait_for(runtime.task, 20)
            with get_connection(settings) as conn:
                locked = conn.execute("SELECT COUNT(*) FROM profiles WHERE active_job_id IS NOT NULL").fetchone()[0]
            assert locked == 0 and not profiles._LOGIN_RUNTIMES and not runtime.qr_path.exists()
            timings.append({"cycle": cycle + 1, "readyMs": ready_ms, "pngBytes": len(image), "expiresInSeconds": result["expires_in_seconds"], "sameQr": True, "cleanup": True})
            print(json.dumps(timings[-1]), flush=True)
        print(json.dumps({"passed": True, "checks": timings}), flush=True)
    finally:
        await profiles.shutdown_login_runtimes()
        await shutdown_browser_contexts()


with tempfile.TemporaryDirectory(prefix="bmusic-login-probe-") as directory:
    asyncio.run(run(Path(directory)))
