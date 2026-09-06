"""Real private HTTP/Chrome handoff and cgroup CPU/memory comparison.

Runs only against synthetic loopback responses and disposable kernel profiles.
No App server, published port, user account or existing container is modified.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import hashlib
import importlib.metadata
import platform
from pathlib import Path
import statistics
import tempfile
import threading
import time

from app.browser import context_manager as runtime
from app.browser.http_state import CookieStateStore
from app.config import get_settings
from app.db import init_db
from app.profile_manager import create_or_get_profile, logout_profile, profile_storage_dir


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        if self.path.startswith("/set-"):
            value = self.path.removeprefix("/set-")
            self.send_header("Set-Cookie", f"runtime_fixture=synthetic-{value}; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax")
        elif self.path == "/delete":
            self.send_header("Set-Cookie", "runtime_fixture=gone; Max-Age=0; Path=/")
        body = json.dumps({"cookie": self.headers.get("Cookie", "")}).encode()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_args):
        pass


def cgroup_snapshot():
    root = Path("/sys/fs/cgroup")
    try:
        cpu = dict(line.split() for line in (root / "cpu.stat").read_text().splitlines())
        memory = dict(line.split() for line in (root / "memory.stat").read_text().splitlines())
        current = int((root / "memory.current").read_text())
        return {"cpu_usec": int(cpu["usage_usec"]), "memory_current": current,
                "anonymous": int(memory["anon"]), "working_set": max(0, current - int(memory["inactive_file"]))}
    except (OSError, ValueError, KeyError):
        return None


class Sampler:
    def __init__(self):
        self.samples = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)
    def sample(self):
        while not self.stop.is_set():
            value = cgroup_snapshot()
            if value is not None:
                self.samples.append(value)
            self.stop.wait(0.005)
    def __enter__(self):
        self.before = cgroup_snapshot()
        self.thread.start()
        self.started = time.perf_counter()
        return self
    def __exit__(self, *_args):
        self.wall_ms = (time.perf_counter() - self.started) * 1000
        self.after = cgroup_snapshot()
        self.stop.set()
        self.thread.join(timeout=2)
    def result(self):
        result = {"wall_ms": self.wall_ms, "memory_samples": len(self.samples), "sample_interval_ms": 5}
        if self.before is not None and self.after is not None and self.samples:
            result.update({"cgroup_cpu_ms": (self.after["cpu_usec"] - self.before["cpu_usec"]) / 1000,
                           "baseline_working_set_mib": self.before["working_set"] / 2**20,
                           "peak_working_set_mib": max(s["working_set"] for s in self.samples) / 2**20,
                           "peak_anonymous_mib": max(s["anonymous"] for s in self.samples) / 2**20,
                           "peak_total_memory_mib": max(s["memory_current"] for s in self.samples) / 2**20})
        return result


async def body(context, url):
    response = await context.request.get(url)
    try:
        assert response.status == 200
        return (await response.json())["cookie"]
    finally:
        await response.dispose()


async def checks(settings, base):
    manager = runtime.BrowserContextManager(settings)
    report = {"checks": [], "launches": 0, "python": platform.python_version(),
              "playwright": importlib.metadata.version("playwright"),
              "source_sha256": {name: hashlib.sha256((Path(runtime.__file__).parent / name).read_bytes()).hexdigest()
                                for name in ("context_manager.py", "http_state.py", "mse_capture.py", "network_capture.py")}}
    original_launch = runtime._launch_context
    async def counted(*args):
        report["launches"] += 1
        return await original_launch(*args)
    runtime._launch_context = counted

    async def http(profile, path):
        lease = await manager.open_request_context(profile)
        try:
            return await body(lease.context, base + path)
        finally:
            await lease.close()

    profile = create_or_get_profile("handoff", settings)["profile_id"]
    other = create_or_get_profile("other", settings)["profile_id"]
    try:
        await http(profile, "/set-http")
        assert "synthetic-http" in await http(profile, "/echo")
        assert await http(other, "/echo") == ""
        assert report["launches"] == 0
        report["checks"].append("fresh HTTP sessions persist cookies and isolate profiles with zero Chrome launches")

        browser = await manager.open_context(profile)
        try:
            assert "synthetic-http" in await body(browser.context, base + "/echo")
            page = await browser.new_page()
            await page.goto(base + "/page")
            session = await browser.context.new_cdp_session(page)
            try:
                report["browser"] = (await session.send("Browser.getVersion"))["product"]
            finally:
                await session.detach()
            await page.evaluate("() => localStorage.setItem('runtime_fixture', 'synthetic-storage')")
            await page.evaluate("""() => new Promise((resolve,reject) => {
                const request=indexedDB.open('runtime_fixture',1);
                request.onupgradeneeded=()=>request.result.createObjectStore('values');
                request.onerror=()=>reject(new Error('IndexedDB open failed'));
                request.onsuccess=()=>{
                    const db=request.result, transaction=db.transaction('values','readwrite');
                    transaction.objectStore('values').put('synthetic-indexeddb','key');
                    transaction.oncomplete=()=>{db.close();resolve(true);};
                    transaction.onerror=()=>{db.close();reject(new Error('IndexedDB write failed'));};
                };
            })""")
            reader = await manager.open_request_context(profile)
            try:
                assert reader.context is browser.context
                await body(reader.context, base + "/set-browser")
            finally:
                await reader.close()
        finally:
            await browser.close()
        assert "synthetic-browser" in await http(profile, "/echo")
        assert report["launches"] == 1
        await http(profile, "/delete")
        browser = await manager.open_context(profile)
        try:
            assert await body(browser.context, base + "/echo") == ""
            page = await browser.new_page()
            await page.goto(base + "/page")
            assert await page.evaluate("() => localStorage.getItem('runtime_fixture')") == "synthetic-storage"
            assert await page.evaluate("""() => new Promise((resolve,reject) => {
                const request=indexedDB.open('runtime_fixture',1);
                request.onerror=()=>reject(new Error('IndexedDB reopen failed'));
                request.onsuccess=()=>{
                    const db=request.result, read=db.transaction('values').objectStore('values').get('key');
                    read.onsuccess=()=>{db.close();resolve(read.result);};
                    read.onerror=()=>{db.close();reject(new Error('IndexedDB read failed'));};
                };
            })""") == "synthetic-indexeddb"
        finally:
            await browser.close()
        report["checks"].append("HTTP/browser handoff, shared reads, cookie deletion, localStorage and IndexedDB are preserved")

        legacy = create_or_get_profile("legacy", settings)["profile_id"]
        context, driver = await original_launch(legacy, settings)
        try:
            await body(context, base + "/set-legacy")
            assert any(cookie["expires"] > time.time() for cookie in await context.cookies()), "legacy fixture must be persistent"
        finally:
            await runtime._close_owned(context, driver)
        before = report["launches"]
        assert "synthetic-legacy" in await http(legacy, "/echo")
        assert "synthetic-legacy" in await http(legacy, "/echo")
        assert report["launches"] == before + 1
        report["checks"].append("legacy Chromium profile migrates once without reading Chromium's SQLite cookie database")

        browser = await manager.open_context(profile)
        await body(browser.context, base + "/set-recovered")
        # Simulate an interrupted runtime after Chrome flushes its persistent
        # profile, leaving the journal marked browser-owned. Never use this
        # fault injection on user data or a running application.
        await runtime._close_owned(browser.context, browser.playwright)
        key = (id(asyncio.get_running_loop()), str(profile_storage_dir(profile, settings).resolve()))
        runtime._STATES.pop(key)
        assert (await CookieStateStore(profile_storage_dir(profile, settings)).load()).source == "browser"
        assert "synthetic-recovered" in await http(profile, "/echo")
        await logout_profile(profile, "handoff", settings)
        assert await http(profile, "/echo") == ""
        report["checks"].append("interrupted browser owner is recovered and logout cannot resurrect older HTTP cookies")
    finally:
        runtime._launch_context = original_launch
        await runtime.shutdown_browser_contexts()

    # Same synthetic response and cookie, same versions/cgroup limits, serial
    # open/get/close workload. Legacy uses the pre-optimization raw browser
    # lifecycle, so its baseline does not pay the new journal/handoff overhead.
    browser_profile = create_or_get_profile("baseline-browser", settings)["profile_id"]
    http_profile = create_or_get_profile("optimized-http", settings)["profile_id"]
    async def request_mode(mode, path):
        if mode == "browser":
            context, driver = await original_launch(browser_profile, settings)
            try:
                return await body(context, base + path)
            finally:
                await runtime._close_owned(context, driver)
        return await http(http_profile, path)
    for mode in ("browser", "http"):
        await request_mode(mode, "/set-benchmark")
        assert "synthetic-benchmark" in await request_mode(mode, "/echo")
    measurements = {"browser": [], "http": []}
    for iteration in range(6):
        for mode in (("browser", "http") if iteration % 2 == 0 else ("http", "browser")):
            with Sampler() as sample:
                assert "synthetic-benchmark" in await request_mode(mode, "/echo")
            measurements[mode].append(sample.result())
    report["request_benchmark"] = {"scope": "isolated serial authenticated HTTP request lifecycle, not whole-site performance",
                                   "runs_per_mode": 6, "samples": measurements}
    report["request_benchmark"]["summary"] = {
        mode: {name: statistics.median(sample[name] for sample in samples)
               for name in samples[0] if name not in {"memory_samples", "sample_interval_ms"}}
        for mode, samples in measurements.items()
    }
    await runtime.shutdown_browser_contexts()
    return report


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="b-music-runtime-http-") as directory:
            root = Path(directory)
            settings = replace(get_settings(), data_dir=root, db_path=root / "kernel.sqlite3",
                               profiles_dir=root / "profiles", artifacts_dir=root / "artifacts")
            init_db(settings)
            report = asyncio.run(checks(settings, f"http://127.0.0.1:{server.server_port}"))
            print(json.dumps(report, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
