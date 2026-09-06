"""Isolated HTTP acceptance server. Never imported by the production application.

Runs the real API, SQLite, Chrome, network capture, downloads and ffmpeg. Only
Bilibili's upstream is replaced by a deterministic local server. All controls
require an explicit guard and an ephemeral /tmp data directory.
"""
from __future__ import annotations

import asyncio
import base64
import os
from pathlib import Path
import subprocess
import threading
import time
from urllib.parse import urlencode, urlsplit

if os.getenv("B_MUSIC_HTTP_FIXTURE") != "isolated-only":
    raise RuntimeError("HTTP fixture is disabled")
root = Path(os.environ["KERNEL_DATA_DIR"]).resolve()
if root.parent != Path("/tmp") or not root.name.startswith("b-music-http-"):
    raise RuntimeError("Fixture requires an isolated /tmp/b-music-http-* directory")
for name in ("KERNEL_DB_PATH", "KERNEL_PROFILES_DIR", "KERNEL_ARTIFACTS_DIR"):
    if os.getenv(name):
        raise RuntimeError("Fixture must not override individual storage paths")
root.mkdir(parents=True, exist_ok=True)
sample = root / "sample.m4a"
subprocess.run([
    "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-c:a", "aac", "-movflags", "+faststart", "-y", str(sample),
], check=True, timeout=15)

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from playwright.async_api import APIRequestContext
from app.main import app
from app.browser import context_manager as browsers
from app import job_manager, profile_manager
from app.bilibili import search
from app.db import get_connection
from app.strategies import browser_network

BASE = "http://127.0.0.1:8000"
browser_network.normalize_video_url = lambda url: BASE + "/__fixture/video?" + urlencode({"bvid": browser_network.parse_bvid(url)})
controls = {"uid": None, "search_error_page": 0, "search_delay": 0.0, "identity_delay": 0.0, "hold_browser": False, "hold_media": False, "fail_media": False,
            "login_generate_error": 0, "login_poll_errors": 0, "login_generate_delay": 0.0}
metrics = {"launches": 0, "search_requests": [], "browser_stage": False, "media_stage": False, "media_runs": 0, "login_generates": 0, "login_polls": 0}
metrics["http_context_launches"] = 0
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afooAAAAASUVORK5CYII=")

@app.middleware("http")
async def slow_identity(request: Request, call_next):
    combined = False
    if request.method == "POST" and request.url.path == "/v1/profiles":
        try:
            combined = bool((await request.json()).get("include_login_status"))
        except (ValueError, AttributeError):
            pass
    if request.url.path.endswith("/login/status") or combined:
        await asyncio.sleep(min(3, float(controls["identity_delay"])))
    return await call_next(request)

original_get = APIRequestContext.get
async def local_api_get(self, url, **kwargs):
    target = urlsplit(str(url))
    if target.hostname in ("api.bilibili.com", "passport.bilibili.com"):
        url = BASE + "/__fixture/upstream" + target.path + ("?" + target.query if target.query else "")
    elif target.hostname not in ("127.0.0.1", "localhost"):
        raise RuntimeError("Fixture refuses external network access")
    return await original_get(self, url, **kwargs)
APIRequestContext.get = local_api_get

original_launch = browsers._launch_context
async def launch(profile_id, settings):
    context, playwright = await original_launch(profile_id, settings)
    metrics["launches"] += 1
    async def route_request(route):
        url = urlsplit(route.request.url)
        if url.hostname in ("127.0.0.1", "localhost"):
            return await route.continue_()
        if url.hostname == "passport.bilibili.com":
            return await route.fulfill(content_type="text/html", body='<div class="login-scan-box" style="width:180px;height:180px;background:#eee">TEST QR — NOT A REAL LOGIN</div>')
        if url.hostname == "www.bilibili.com" and url.path.startswith("/video/"):
            return await route.fulfill(content_type="text/html", body=f'<video controls autoplay muted style="width:400px;height:200px" src="{BASE}/__fixture/audio.m4s"></video>')
        return await route.abort()
    await context.route("**/*", route_request)
    return context, playwright
browsers._launch_context = launch

original_http_launch = browsers._launch_request_context
async def launch_http(settings, cookies):
    context, playwright = await original_http_launch(settings, cookies)
    metrics["http_context_launches"] += 1
    return context, playwright
browsers._launch_request_context = launch_http

original_wait = browser_network._wait_with_cancellation
async def gated_browser_wait(page, wait_ms, context):
    metrics["browser_stage"] = True
    deadline = time.monotonic() + 25
    try:
        while controls["hold_browser"] and time.monotonic() < deadline:
            context.raise_if_cancelled()
            await asyncio.sleep(0.05)
        await original_wait(page, min(wait_ms, 1000), context)
    finally:
        metrics["browser_stage"] = False
browser_network._wait_with_cancellation = gated_browser_wait

original_process = job_manager.process_media
def gated_process(*args, **kwargs):
    metrics["media_stage"] = True
    metrics["media_runs"] += 1
    deadline = time.monotonic() + 25
    try:
        while controls["hold_media"] and time.monotonic() < deadline:
            cancel = kwargs.get("cancel_requested")
            if cancel and cancel():
                from app.strategies.base import StrategyCancelled
                raise StrategyCancelled("fixture cancellation")
            threading.Event().wait(0.05)
        if controls["fail_media"]:
            raise RuntimeError("fixture media failure")
        return original_process(*args, **kwargs)
    finally:
        metrics["media_stage"] = False
job_manager.process_media = gated_process

@app.get("/__fixture/state")
def fixture_state():
    with get_connection() as conn:
        locks = conn.execute("SELECT COUNT(*) FROM profiles WHERE active_job_id IS NOT NULL AND active_job_id!=''").fetchone()[0]
        readers = conn.execute("SELECT COUNT(*) FROM profile_readers").fetchone()[0]
        active = conn.execute("SELECT COUNT(*) FROM jobs WHERE status NOT IN ('succeeded','failed','cancelled')").fetchone()[0]
    return {"fixture":"isolated-only", **metrics, "locks":locks, "readers":readers, "active_jobs":active,
            "browser_leases":sum(state.users for state in browsers._STATES.values()),
            "browsers":sum(state.context is not None for state in browsers._STATES.values()),
            "http_leases":sum(state.request_users for state in browsers._STATES.values()),
            "http_contexts":sum(state.request_context is not None for state in browsers._STATES.values()),
            "login_watchers":len(profile_manager._LOGIN_RUNTIMES)}

@app.post("/__fixture/control")
async def fixture_control(request: Request):
    body = await request.json()
    for key, value in body.items():
        if key not in controls:
            raise HTTPException(400, "unknown fixture control")
        controls[key] = value
    return {"updated": True}

@app.post("/__fixture/expire-login")
async def expire_login():
    for runtime in profile_manager._LOGIN_RUNTIMES.values():
        runtime.expires_at_monotonic = time.monotonic() - 1
    return {"expired": True}

@app.post("/__fixture/expire-artifact/{job_id}")
def expire_artifact(job_id: str):
    target = job_manager.artifact_path(job_id, "audio.m4a").resolve()
    if root not in target.parents:
        raise HTTPException(400, "not isolated")
    target.unlink()
    return {"expired":True}

@app.get("/__fixture/audio.m4s")
def audio():
    return FileResponse(sample, media_type="audio/mp4")

@app.get("/__fixture/video")
def video():
    # Both page and media are loopback: Chrome must not block fixture audio as
    # HTTPS-to-private-network mixed content. No browser safety flags are changed.
    return HTMLResponse(f'<video controls autoplay muted style="width:400px;height:200px" src="{BASE}/__fixture/audio.m4s"></video>')

@app.get("/__fixture/upstream/x/web-interface/nav")
def nav():
    uid = controls["uid"]
    return {"code":0,"data":{"isLogin":uid is not None,"mid":uid,"uname":"Fixture " + str(uid)}}


@app.get("/__fixture/upstream/x/passport-login/web/qrcode/generate")
async def generate_qr():
    metrics["login_generates"] += 1
    await asyncio.sleep(min(15, max(0, float(controls["login_generate_delay"]))))
    if controls["login_generate_error"]:
        return Response(status_code=int(controls["login_generate_error"]))
    return {"code": 0, "data": {"qrcode_key": "isolated-fixture-not-a-login",
            "url": "https://account.bilibili.com/h5/account-h5/auth/scan-web?authCode=isolated-fixture-not-a-login"}}


@app.get("/__fixture/upstream/x/passport-login/web/qrcode/poll")
def poll_qr():
    metrics["login_polls"] += 1
    if controls["login_poll_errors"]:
        controls["login_poll_errors"] -= 1
        return Response(status_code=503)
    return {"code": 0, "data": {"code": 0 if controls["uid"] is not None else 86101}}

@app.get("/__fixture/upstream/x/web-interface/search/type")
async def search_upstream(page: int = 1, page_size: int = 20, keyword: str = ""):
    metrics["search_requests"].append({"page":page,"keyword":keyword})
    await asyncio.sleep(min(5, float(controls["search_delay"])))
    if controls["search_error_page"] == page:
        return Response(status_code=503)
    ids = list(range((page-1)*page_size+1, page*page_size+1)) if page <= 6 else []
    if page == 2 and ids:
        ids[0] = page_size  # deterministic overlapping upstream page
    return {"code":0,"data":{"numPages":6,"result":[{
        "bvid":"BV1test" + str(index).zfill(5), "title":f"Fixture Music {index}",
        "mid":"4242" if index % 3 == 0 else "7", "author":"Fixture UP", "duration":"00:12",
        "pic":"https://i0.hdslb.com/bfs/fixture.png", "pubdate":1700000000,
    } for index in ids]}}

@app.get("/__fixture/upstream/x/web-interface/card")
def card():
    return {"code":0,"data":{"card":{"name":"Fixture UP"}}}

@app.get("/__fixture/image/{name}")
def cover(name: str):
    if name == "redirect.png":
        return Response(status_code=302, headers={"location":"http://127.0.0.1:1/private"})
    if name == "unsafe.svg":
        return Response("<svg xmlns='http://www.w3.org/2000/svg'/>", media_type="image/svg+xml")
    return Response(PNG, media_type="image/png")
