import assert from "node:assert/strict";
import test from "node:test";
import { getDefaultKernelLoginStatus } from "../lib/kernelSession";
import { withAccountRequest } from "../lib/accountRequest";

const profile = { profile_id: "p_runtime_test", external_owner_id: "runtime-test", status: "exists" };
const identity = { profile_id: profile.profile_id, logged_in: true, bili_uid: "123", nickname: "first",
  last_verified_at: "2026-09-06T01:00:00Z", login_status: "logged_in" };

test("combined profile status uses one uncached HTTP request and retains the exact legacy result", async () => {
  const fetch = globalThis.fetch;
  const mode = process.env.APP_LIBRARY_MODE;
  const owner = process.env.KERNEL_EXTERNAL_OWNER_ID;
  process.env.APP_LIBRARY_MODE = "account";
  process.env.KERNEL_EXTERNAL_OWNER_ID = profile.external_owner_id;
  const calls: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input); calls.push(url);
      assert.equal(init?.cache, "no-store");
      if (url.endsWith("/v1/profiles")) return Response.json(profile);
      assert.ok(url.includes("/login/status?"));
      return Response.json(identity);
    };
    const legacy = await getDefaultKernelLoginStatus();
    assert.equal(calls.length, 2);
    calls.length = 0;
    globalThis.fetch = async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.cache, "no-store");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        external_owner_id: profile.external_owner_id, include_login_status: true,
      });
      return Response.json({ ...profile, login: identity });
    };
    assert.deepEqual(await getDefaultKernelLoginStatus(), legacy);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = fetch;
    if (mode === undefined) delete process.env.APP_LIBRARY_MODE; else process.env.APP_LIBRARY_MODE = mode;
    if (owner === undefined) delete process.env.KERNEL_EXTERNAL_OWNER_ID; else process.env.KERNEL_EXTERNAL_OWNER_ID = owner;
  }
});

test("identity is shared only within one incoming request and refreshes across logout and account switch", async () => {
  const fetch = globalThis.fetch;
  const mode = process.env.APP_LIBRARY_MODE;
  process.env.APP_LIBRARY_MODE = "account";
  let current = { ...identity };
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ ...profile, login: current }); };
  try {
    const [first, same] = await withAccountRequest({ expectedContext: null }, () => Promise.all([
      getDefaultKernelLoginStatus(), getDefaultKernelLoginStatus(),
    ]));
    assert.deepEqual(first, same); assert.equal(calls, 1);
    current = { ...identity, logged_in: false, bili_uid: "", login_status: "logged_out" };
    const loggedOut = await getDefaultKernelLoginStatus();
    assert.equal(loggedOut.loggedIn, false); assert.notEqual(loggedOut.sessionKey, first.sessionKey);
    current = { ...identity, bili_uid: "456", nickname: "second" };
    const second = await getDefaultKernelLoginStatus();
    assert.equal(second.appOwnerId, "bili:456"); assert.notEqual(second.sessionKey, first.sessionKey);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = fetch;
    if (mode === undefined) delete process.env.APP_LIBRARY_MODE; else process.env.APP_LIBRARY_MODE = mode;
  }
});

test("combined identity rejects a different profile and does not hide upstream failures with a retry", async () => {
  const fetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ ...profile, login: { ...identity, profile_id: "other" } });
    await assert.rejects(getDefaultKernelLoginStatus(), /mismatched login profile/);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ detail: "unavailable" }, { status: 503 }); };
    await assert.rejects(getDefaultKernelLoginStatus(), /unavailable/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = fetch; }
});
