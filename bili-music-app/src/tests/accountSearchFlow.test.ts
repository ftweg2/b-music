import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { resolveSearchSelection, SearchSessionError } from "../lib/search/selection";
import { bindSearchResult, failedSearchAttempt, pageAttempt, searchEntry, searchUrl, normalizeSearchSnapshot } from "../lib/search/state";
import { POST as logout } from "../app/api/kernel/login/logout/route";
import { closeDatabaseForTests, createFavoriteVideo, listFavoriteVideos } from "../lib/db";
import { saveCandidateMetadata, normalizeRawSearchResult } from "../lib/search/cache";
import { createPlaylist, listPlaylists } from "../lib/playlists";
import { getDefaultKernelLoginStatus } from "../lib/kernelSession";

function status(loggedIn = true, key = "session-a"): Awaited<ReturnType<typeof getDefaultKernelLoginStatus>> {
  return { profileId: "p_test", externalOwnerId: "local", loggedIn, sessionKey: key, loginStatus: loggedIn ? "logged_in" : "logged_out", appOwnerId: "local", libraryMode: "local" };
}
test("a new automatic search prefers an authenticated kernel", async () => {
  const selected = await resolveSearchSelection("auto", true, 1, undefined, async () => status());
  assert.equal(selected.provider, "kernel"); assert.equal(selected.sessionKey, "session-a");
});
test("new automatic search uses public source when logged out, without hiding a later failure", async () => {
  assert.equal((await resolveSearchSelection("auto", true, 1, undefined, async () => status(false))).provider, "bilibili");
  assert.equal((await resolveSearchSelection("auto", true, 1, undefined, async () => { throw new Error("offline"); })).provider, "bilibili");
});
test("explicit public and local search do not depend on kernel availability", async () => {
  const fail = async () => { throw new Error("must not run"); };
  assert.equal((await resolveSearchSelection("bilibili", true, 2, undefined, fail)).provider, "bilibili");
  assert.equal((await resolveSearchSelection("kernel", false, 2, undefined, fail)).provider, "bilibili");
});
test("pagination cannot resolve an automatic source again", async () => {
  await assert.rejects(resolveSearchSelection("auto", true, 2, undefined, async () => status()), SearchSessionError);
});
test("kernel pagination rejects missing, changed and logged-out sessions", async () => {
  await assert.rejects(resolveSearchSelection("kernel", true, 2, undefined, async () => status()), SearchSessionError);
  await assert.rejects(resolveSearchSelection("kernel", true, 2, "session-a", async () => status(true, "session-b")), SearchSessionError);
  await assert.rejects(resolveSearchSelection("kernel", true, 2, "session-a", async () => status(false)), SearchSessionError);
  assert.equal((await resolveSearchSelection("kernel", true, 2, "session-a", async () => status())).provider, "kernel");
});
test("page attempts bind source, query, size and account context to the successful result", () => {
  const original = { keyword: "music", provider: "auto" as const, useRemote: true, limit: 50, page: 1 };
  const result = bindSearchResult(original, { source: "remote", provider: "kernel", limit: 20, page: 1, sessionKey: "session-a", candidates: [], hasNextPage: true });
  assert.deepEqual(pageAttempt(result, 2), { ...original, provider: "kernel", limit: 20, page: 2, sessionKey: "session-a" });
  assert.equal(result.request.page, 1);
  assert.equal(original.provider, "auto");
});
test("entry URLs distinguish explicit discovery clicks from ordinary result restoration", () => {
  const request = { keyword: "歌 & 曲", provider: "auto" as const, useRemote: true, limit: 20, page: 1 };
  const link = searchUrl(request, true);
  assert.equal(searchEntry(link.split("?")[1]).run, true);
  assert.equal(searchEntry(link.split("?")[1]).request.keyword, request.keyword);
  assert.equal(searchEntry("q=music&provider=kernel&page=2").run, false);
  assert.equal(searchEntry("q=music&page=999&limit=NaN").request.page, 10);
});
test("retry of an initial automatic search keeps the source chosen before failure", () => {
  const request = { keyword: "music", provider: "auto" as const, useRemote: true, limit: 20, page: 1 };
  assert.deepEqual(failedSearchAttempt(request, { provider: "kernel", sessionKey: "a" }), { ...request, provider: "kernel", sessionKey: "a" });
});
test("mixed-source legacy cache and expired cache are never restored", () => {
  assert.equal(normalizeSearchSnapshot({ keyword: "old", provider: "bilibili", candidates: [] }), null);
  const result = bindSearchResult({ keyword: "music", provider: "bilibili", useRemote: true, limit: 20, page: 1 }, { source: "remote", provider: "bilibili", limit: 20, page: 1, searchId: "test-snapshot", candidates: [], hasNextPage: false });
  assert.ok(normalizeSearchSnapshot(result));
  assert.equal(normalizeSearchSnapshot({ ...result, updatedAt: "2000-01-01T00:00:00Z" }), null);
});
test("logout requires confirmation and rejects cross-origin requests before contacting kernel", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not run"); };
  try {
    assert.equal((await logout(new Request("http://localhost/api/kernel/login/logout", { method: "POST", body: "{}" }))).status, 400);
    assert.equal((await logout(new Request("http://localhost/api/kernel/login/logout", { method: "POST", headers: { origin: "https://other.example" }, body: '{"confirmed":true}' }))).status, 403);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test("logout clears only login state and leaves local favorites and playlists intact", async () => {
  closeDatabaseForTests(); process.env.DATABASE_PATH = path.join(os.tmpdir(), `account-library-${crypto.randomUUID()}.sqlite`);
  const candidate = saveCandidateMetadata(normalizeRawSearchResult({ bvid: "BV1test00001", title: "keep" }, "keep", "test"));
  createFavoriteVideo(candidate.id); createPlaylist("local", { name: "keep", candidateId: candidate.id });
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return String(url).endsWith("/v1/profiles") ? Response.json({ profile_id: "p_test", external_owner_id: "local", status: "exists" }) : Response.json({ logged_in: false });
  };
  try {
    const response = await logout(new Request("http://localhost/api/kernel/login/logout", { method: "POST", body: '{"confirmed":true}' }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).loggedIn, false);
    assert.match(urls[1], /p_test\/login\/logout$/);
    assert.equal(listFavoriteVideos(10).length, 1);
    assert.equal(listPlaylists("local").length, 1);
  } finally { globalThis.fetch = original; closeDatabaseForTests(); }
});
