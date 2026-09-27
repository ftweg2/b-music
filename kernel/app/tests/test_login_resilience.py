import asyncio
import json
import time
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from playwright.async_api import Error as BrowserError

from app import profile_manager as profiles
from app.bilibili import qr_login
from app.config import get_settings
from app.db import init_db, get_connection
from app.routers import profiles as routes


class Reply:
    def __init__(self, data=None, status=200, raw=None):
        self.status, self.raw, self.disposed = status, raw, False
        self.data = data if data is not None else {"code": 0, "data": {"code": 86101}}

    async def body(self):
        return self.raw if self.raw is not None else json.dumps(self.data).encode()

    async def dispose(self):
        self.disposed = True


class RequestContext:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    async def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        value = self.replies.pop(0) if self.replies else Reply()
        if isinstance(value, BaseException):
            raise value
        return value


def setup(tmp_path, monkeypatch, **options):
    settings = replace(get_settings(), data_dir=tmp_path, db_path=tmp_path / "kernel.sqlite3",
                       profiles_dir=tmp_path / "profiles", artifacts_dir=tmp_path / "artifacts",
                       login_poll_interval_seconds=0.001, **options)
    init_db(settings)
    profile = profiles.create_or_get_profile("owner", settings)["profile_id"]
    monkeypatch.setattr(profiles, "_LOGIN_RUNTIMES", {})
    monkeypatch.setattr(profiles, "_LOGIN_STARTS", {})
    monkeypatch.setattr(profiles, "_LOGIN_RUNTIME_LOCK", None)
    return settings, profile


def fake_browser(monkeypatch, *, delay=0, replies=()):
    managed = SimpleNamespace(context=SimpleNamespace(request=RequestContext(replies)), opens=0, closed=0)

    async def close():
        managed.closed += 1

    managed.close = close

    class Browser:
        def __init__(self, settings):
            pass

        async def open_request_context(self, profile):
            managed.opens += 1
            await asyncio.sleep(delay)
            return managed

    monkeypatch.setattr("app.browser.context_manager.BrowserContextManager", Browser)
    return managed


def generated():
    return Reply({"code": 0, "data": {"qrcode_key": "isolated-key", "url": "https://account.bilibili.com/h5/account-h5/auth/scan-web?authCode=isolated-key"}})


def test_create_png_uses_only_the_first_party_api_and_disposes_response(tmp_path):
    reply = generated()
    request = RequestContext([reply])
    path = tmp_path / "qr.png"
    challenge = asyncio.run(qr_login.create_qr(SimpleNamespace(request=request), path, get_settings()))
    assert path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    assert len(path.read_bytes()) < 50_000
    assert challenge.key == "isolated-key" and "isolated-key" not in repr(challenge)
    assert reply.disposed
    assert len(request.calls) == 1
    assert request.calls[0][0].endswith("/web/qrcode/generate")
    assert request.calls[0][1]["max_redirects"] == 0
    assert request.calls[0][1]["timeout"] <= 10_000


@pytest.mark.parametrize("reply,code,status,retryable", [
    (Reply(status=503), "LOGIN_UPSTREAM_UNAVAILABLE", 502, True),
    (Reply(status=403), "LOGIN_UPSTREAM_RESTRICTED", 503, False),
    (Reply(status=429), "LOGIN_UPSTREAM_RESTRICTED", 503, False),
    (Reply(raw=b"<html>upstream error</html>"), "LOGIN_INVALID_RESPONSE", 502, True),
    (Reply(raw=b"x" * 65537), "LOGIN_INVALID_RESPONSE", 502, True),
    (TimeoutError("private token must not escape"), "LOGIN_UPSTREAM_TIMEOUT", 504, True),
    (BrowserError("APIRequestContext.get: Timeout 10000ms exceeded. private token must not escape"), "LOGIN_UPSTREAM_TIMEOUT", 504, True),
    (BrowserError("APIRequestContext.get: Request timed out after 10000ms\nprivate token must not escape"), "LOGIN_UPSTREAM_TIMEOUT", 504, True),
    (BrowserError("private token must not escape"), "LOGIN_UPSTREAM_UNAVAILABLE", 502, True),
])
def test_upstream_failures_are_typed_and_do_not_disclose_internals(tmp_path, reply, code, status, retryable):
    with pytest.raises(qr_login.LoginFlowError) as result:
        asyncio.run(qr_login.create_qr(SimpleNamespace(request=RequestContext([reply])), tmp_path / "qr.png", get_settings()))
    assert (result.value.code, result.value.status, result.value.retryable) == (code, status, retryable)
    assert "private token" not in str(result.value)
    assert not (tmp_path / "qr.png").exists()


@pytest.mark.parametrize("url", ["http://account.bilibili.com/qr", "https://evil.example/qr", "https://account.bilibili.com:bad/qr", "https://user@account.bilibili.com/qr"])
def test_untrusted_qr_targets_are_rejected(tmp_path, url):
    reply = Reply({"code": 0, "data": {"qrcode_key": "test", "url": url}})
    with pytest.raises(qr_login.LoginFlowError, match="二维码地址"):
        asyncio.run(qr_login.create_qr(SimpleNamespace(request=RequestContext([reply])), tmp_path / "qr.png", get_settings()))


@pytest.mark.parametrize("code,state", [(86101, "waiting_scan"), (86090, "waiting_confirm"), (86038, "expired"), (0, "confirmed")])
def test_poll_states_use_the_same_challenge_without_generating_another(code, state):
    request = RequestContext([Reply({"code": 0, "data": {"code": code}})])
    assert asyncio.run(qr_login.poll_qr(SimpleNamespace(request=request), qr_login.QRChallenge("private-key"), get_settings())) == state
    assert request.calls[0][1]["params"]["qrcode_key"] == "private-key"
    assert request.calls[0][0].endswith("/qrcode/poll")


def test_concurrent_starts_share_preparation_and_a_disconnected_caller_can_recover(tmp_path, monkeypatch):
    settings, profile = setup(tmp_path, monkeypatch)
    browser = fake_browser(monkeypatch, delay=0.04, replies=[generated()])

    async def run():
        first = asyncio.create_task(profiles.start_login(profile, "owner", settings))
        await asyncio.sleep(0.01)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        results = await asyncio.gather(*(profiles.start_login(profile, "owner", settings) for _ in range(6)))
        assert len({result["login_session_id"] for result in results}) == 1
        assert browser.opens == 1
        assert len([call for call in browser.context.request.calls if call[0].endswith("generate")]) == 1
        assert "isolated-key" not in json.dumps(results)
        await profiles.logout_profile(profile, "owner", settings)
        assert not profiles._LOGIN_RUNTIMES and not profiles._LOGIN_STARTS
        assert profiles.get_profile(profile, settings)["active_job_id"] is None

    asyncio.run(run())


def test_preparation_timeout_cleans_up_and_next_attempt_can_succeed(tmp_path, monkeypatch):
    settings, profile = setup(tmp_path, monkeypatch, login_preparation_timeout_seconds=0.02)
    fake_browser(monkeypatch, delay=0.1)

    async def run():
        with pytest.raises(qr_login.LoginFlowError) as failed:
            await profiles.start_login(profile, "owner", settings)
        assert failed.value.status == 504 and failed.value.code == "LOGIN_PREPARATION_TIMEOUT"
        assert profiles.get_profile(profile, settings)["active_job_id"] is None
        assert not profiles._LOGIN_STARTS and not profiles._LOGIN_RUNTIMES
        browser = fake_browser(monkeypatch, replies=[generated()])
        result = await profiles.start_login(profile, "owner", replace(settings, login_preparation_timeout_seconds=1))
        assert result["status"] == "pending" and browser.opens == 1
        await profiles.shutdown_login_runtimes()
        assert profiles.get_profile(profile, settings)["active_job_id"] is None
    asyncio.run(run())


def test_explicit_cancel_can_stop_preparation_without_leaving_a_lock(tmp_path, monkeypatch):
    settings, profile = setup(tmp_path, monkeypatch)
    fake_browser(monkeypatch, delay=10)

    async def run():
        start = asyncio.create_task(profiles.start_login(profile, "owner", settings))
        await asyncio.sleep(0.01)
        await profiles.logout_profile(profile, "owner", settings)
        with pytest.raises(asyncio.CancelledError):
            await start
        assert profiles.get_profile(profile, settings)["active_job_id"] is None
        assert not profiles._LOGIN_STARTS and not profiles._LOGIN_RUNTIMES
    asyncio.run(run())


def test_poll_recovers_from_transient_failure_and_verifies_identity_before_success(tmp_path, monkeypatch):
    settings, profile = setup(tmp_path, monkeypatch)
    browser = fake_browser(monkeypatch, replies=[generated(), TimeoutError("network"), Reply({"code": 0, "data": {"code": 86090}}), Reply({"code": 0, "data": {"code": 0}})])
    verifies = []

    async def identity(context, settings):
        verifies.append(True)
        if len(verifies) == 1:
            raise BrowserError("transient nav failure")
        return {"logged_in": True, "bili_uid": "12345", "nickname": "Test"}
    monkeypatch.setattr(profiles, "_verify_bilibili_identity", identity)

    async def run():
        result = await profiles.start_login(profile, "owner", settings)
        runtime = profiles._LOGIN_RUNTIMES[result["login_session_id"]]
        await asyncio.wait_for(runtime.task, 2)
        assert profiles.get_login_status(profile, settings)["bili_uid"] == "12345"
        assert len(verifies) == 2
        assert profiles.get_profile(profile, settings)["active_job_id"] is None
        assert not runtime.qr_path.exists() and browser.closed == 1
        with pytest.raises(profiles.ProfileLockedError):
            await profiles.start_login(profile, "owner", settings)
    asyncio.run(run())


def test_qr_lifetime_starts_when_ready_and_expires_without_replacing_the_image(tmp_path, monkeypatch):
    settings, profile = setup(tmp_path, monkeypatch, login_session_timeout_seconds=1, login_qr_refresh_seconds=0)
    browser = fake_browser(monkeypatch, replies=[generated()])

    async def run():
        result = await profiles.start_login(profile, "owner", settings)
        runtime = profiles._LOGIN_RUNTIMES[result["login_session_id"]]
        with get_connection(settings) as conn:
            conn.execute("UPDATE login_sessions SET created_at='2000-01-01T00:00:00+00:00' WHERE login_session_id=?", (result["login_session_id"],))
        assert profiles.get_login_qr_image_path(profile_id=profile, external_owner_id="owner", login_session_id=result["login_session_id"], settings=settings).is_file()
        before = runtime.qr_path.read_bytes()
        await asyncio.sleep(0.02)
        assert runtime.qr_path.read_bytes() == before
        runtime.expires_at_monotonic = time.monotonic() - 1
        await asyncio.wait_for(runtime.task, 1)
        assert not runtime.qr_path.exists()
        assert not profiles._LOGIN_RUNTIMES
        assert len([call for call in browser.context.request.calls if call[0].endswith("generate")]) == 1
    asyncio.run(run())


def test_login_endpoint_returns_a_retryable_504_instead_of_unhandled_500(monkeypatch):
    async def fail(*args):
        raise qr_login.LoginFlowError("LOGIN_PREPARATION_TIMEOUT", "二维码准备超时，请重试。", 504)
    monkeypatch.setattr(routes, "start_login", fail)
    app = FastAPI()
    app.include_router(routes.router)

    async def run():
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/v1/profiles/p_1234567890abcdef/login/start", json={"external_owner_id": "owner"})
        assert response.status_code == 504
        assert response.headers["x-error-code"] == "LOGIN_PREPARATION_TIMEOUT"
        assert response.headers["retry-after"] == "3"
        assert response.headers["x-error-retryable"] == "true"
    asyncio.run(run())
