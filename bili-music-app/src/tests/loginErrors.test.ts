import assert from "node:assert/strict";
import test from "node:test";
import { readKernelJson, KernelRequestError } from "../lib/kernelClient";
import { loginErrorResponse } from "../lib/loginApi";
import { requestLoginAction } from "../lib/loginClient";
import { publishClientAccount } from "../lib/accountClient";

test("login timeout retains a typed 504 and retry hint across the App proxy", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ detail: "二维码准备超时，请重试。" }, { status: 504, headers: { "x-error-code": "LOGIN_PREPARATION_TIMEOUT", "retry-after": "3" } });
  try {
    let failure: unknown;
    try { await readKernelJson("/v1/profiles/test/login/start"); } catch (error) { failure = error; }
    assert.ok(failure instanceof KernelRequestError);
    const response = loginErrorResponse(failure);
    assert.equal(response.status, 504);
    assert.equal(response.headers.get("retry-after"), "3");
    const body = await response.json();
    assert.equal(body.code, "LOGIN_PREPARATION_TIMEOUT");
    assert.equal(body.retryable, true);
    assert.doesNotMatch(body.error, /HTTP 500/);
  } finally { globalThis.fetch = original; }
});

test("upstream restrictions are explicit and do not trigger automatic retry advice", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ detail: "请在 B 站完成验证" }, { status: 503, headers: { "x-error-code": "LOGIN_UPSTREAM_RESTRICTED", "x-error-retryable": "false" } });
  try {
    let failure: unknown;
    try { await readKernelJson("/login"); } catch (error) { failure = error; }
    const response = loginErrorResponse(failure);
    assert.equal(response.headers.get("retry-after"), null);
    assert.equal((await response.json()).retryable, false);
  } finally { globalThis.fetch = original; }
});

test("client handles gateway HTML errors and network timeout with actionable messages", async () => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
  publishClientAccount({ appOwnerId: "guest:login-test", sessionKey: "login-test", libraryMode: "account", loggedIn: false });
  try {
    globalThis.fetch = async () => new Response("<html>Internal Server Error</html>", { status: 500 });
    await assert.rejects(requestLoginAction("/api/kernel/login/start", {}), /登录服务暂时不可用/);
    globalThis.fetch = async () => { throw new DOMException("timed out", "TimeoutError"); };
    await assert.rejects(requestLoginAction("/api/kernel/login/start", {}), /已有待扫码会话会被复用/);
    globalThis.fetch = async () => Response.json({ loginSessionId: "ls_test" });
    assert.equal((await requestLoginAction<{loginSessionId: string}>("/api/kernel/login/start", {})).loginSessionId, "ls_test");
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; }
});
