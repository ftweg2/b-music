"""Real Playwright HTTP/cookie integration, without Chrome or privileged Docker."""
import asyncio
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

from app.browser import context_manager as runtime
from app.browser.http_state import CookieStateStore
from app.config import get_settings
from app.db import init_db
from app.profile_manager import create_or_get_profile, logout_profile, profile_storage_dir


def test_real_http_transport_persists_set_cookie_expiry_and_profile_isolation_without_browser(tmp_path, monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            if self.path == "/set":
                self.send_header("Set-Cookie", "runtime_fixture=synthetic-value; Path=/; HttpOnly; SameSite=Lax")
            elif self.path == "/delete":
                self.send_header("Set-Cookie", "runtime_fixture=gone; Max-Age=0; Path=/")
            body = (self.headers.get("Cookie") or "").encode()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    settings = replace(get_settings(), data_dir=tmp_path, db_path=tmp_path / "kernel.sqlite3",
                       profiles_dir=tmp_path / "profiles", artifacts_dir=tmp_path / "artifacts")
    init_db(settings)
    first = create_or_get_profile("first", settings)["profile_id"]
    second = create_or_get_profile("second", settings)["profile_id"]

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("HTTP-only operations must never launch a browser")
    monkeypatch.setattr(runtime, "_launch_context", forbidden)

    async def run():
        manager = runtime.BrowserContextManager(settings)
        base = f"http://127.0.0.1:{server.server_port}"
        async def request(profile, route):
            lease = await manager.open_request_context(profile)
            try:
                response = await lease.context.request.get(base + route)
                try:
                    return await response.text()
                finally:
                    await response.dispose()
            finally:
                await lease.close()
        try:
            await request(first, "/set")
            snapshot = await CookieStateStore(profile_storage_dir(first, settings)).load()
            assert snapshot.source == "http"
            assert any(cookie["name"] == "runtime_fixture" for cookie in snapshot.cookies)
            assert "runtime_fixture=synthetic-value" in await request(first, "/echo")
            assert await request(second, "/echo") == ""
            await request(first, "/delete")
            assert await request(first, "/echo") == ""
            await request(first, "/set")
            await logout_profile(first, "first", settings)
            assert await request(first, "/echo") == ""
            state = runtime._state_for(first, settings)
            assert state.request_users == 0 and state.request_context is None and state.context is None
        finally:
            await runtime.shutdown_browser_contexts()
    try:
        asyncio.run(run())
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
