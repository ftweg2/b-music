import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { closeDatabaseForTests, getDatabase, createPreferredCreator } from "../lib/db";
import { runSearch, saveCandidateMetadata, normalizeRawSearchResult } from "../lib/search/cache";
import { SearchSnapshotError } from "../lib/search/sessions";
import { pageNumbers, pageLimit, validTotalPages } from "../lib/search/pagination";
import { resetRateLimitsForTests } from "../lib/rateLimit";
import { bindSearchResult, pageAttempt, searchEntry, searchUrl } from "../lib/search/state";
import type { RawSearchResult, SearchProvider } from "../lib/search/types";

function setup() {
  closeDatabaseForTests();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `stable-pages-${crypto.randomUUID()}.sqlite`);
  delete process.env.BILIBILI_SEARCH_LIMIT;
  resetRateLimitsForTests();
}
function song(index: number, creator = "1"): RawSearchResult {
  return { bvid: "BV1test" + String(index).padStart(5, "0"), title: "music " + index, creatorMid: creator };
}
const base = { keyword: "music", useRemote: true, limit: 3 };
const bvids = (result: Awaited<ReturnType<typeof runSearch>>) => result.candidates.map((item) => item.bvid);

test("cross-page duplicates never spill forward or trigger refill requests", async () => {
  setup(); const calls: number[] = [];
  const provider: SearchProvider = {
    name: "stable-test", searchVideos: async () => [],
    searchPage: async (_key, options) => { calls.push(options.page); return { results: options.page === 1 ? [song(1), song(2), song(3)] : [song(2), song(3), song(4)], hasNextPage: true, totalPages: 10 }; },
  };
  const first = await runSearch({ ...base, searchProvider: provider });
  const second = await runSearch({ ...base, page: 2, searchId: first.searchId, searchProvider: provider });
  assert.deepEqual(bvids(second), [song(4).bvid]);
  assert.equal(second.duplicatesRemoved, 2);
  assert.equal(second.hasNextPage, true);
  assert.deepEqual(calls, [1, 2]);
});
test("revisiting a page uses frozen membership and order even after upstream changes", async () => {
  setup(); let calls = 0;
  const provider: SearchProvider = { name: "stable-test", searchVideos: async () => { calls++; return calls === 1 ? [song(1), song(2)] : [song(99), song(1)]; } };
  const first = await runSearch({ ...base, searchProvider: provider });
  for (let index = 0; index < 16; index++) {
    const revisited = await runSearch({ ...base, searchId: first.searchId, searchProvider: provider });
    assert.deepEqual(bvids(revisited), bvids(first)); assert.equal(revisited.cached, true);
  }
  assert.equal(calls, 1);
});
test("direct jump requests only the target page; earlier visits cannot move its tracks", async () => {
  setup(); const calls: number[] = [];
  const provider: SearchProvider = { name: "jump-test", searchVideos: async (_key, options) => {
    calls.push(options.page); return options.page === 5 ? [song(5), song(1)] : [song(1), song(2)];
  } };
  const fifth = await runSearch({ ...base, page: 5, searchProvider: provider });
  const first = await runSearch({ ...base, page: 1, searchId: fifth.searchId, searchProvider: provider });
  assert.deepEqual(bvids(first), [song(2).bvid]);
  assert.deepEqual(bvids(await runSearch({ ...base, page: 5, searchId: fifth.searchId, searchProvider: provider })), bvids(fifth));
  assert.deepEqual(calls, [5, 1]);
});
test("local pages stay fixed when metadata or followed creators change", async () => {
  setup();
  for (let index = 1; index <= 5; index++) saveCandidateMetadata(normalizeRawSearchResult(song(index), "music", "test"));
  const first = await runSearch({ keyword: "music", useRemote: false, limit: 2 });
  const originalIds = getDatabase().prepare("SELECT id FROM candidate_videos ORDER BY last_seen_at DESC,id DESC").all().map((row) => Number(row.id));
  saveCandidateMetadata(normalizeRawSearchResult(song(20, "2"), "music", "test"));
  createPreferredCreator({ biliMid: "2", name: "new followed" });
  const second = await runSearch({ keyword: "music", useRemote: false, limit: 2, page: 2, searchId: first.searchId });
  assert.deepEqual(second.candidates.map((item) => item.id), originalIds.slice(2, 4));
  assert.equal(second.totalPages, 3);
  assert.deepEqual(bvids(await runSearch({ keyword: "music", useRemote: false, limit: 2, searchId: first.searchId })), bvids(first));
});
test("saved pages survive a database reopen and stale candidate IDs are repaired", async () => {
  setup(); let calls = 0;
  const provider: SearchProvider = { name: "persist-test", searchVideos: async () => { calls++; return [song(1)]; } };
  const first = await runSearch({ ...base, searchProvider: provider });
  getDatabase().prepare("DELETE FROM candidate_videos WHERE id=?").run(first.candidates[0].id);
  closeDatabaseForTests();
  const again = await runSearch({ ...base, searchId: first.searchId, searchProvider: provider });
  assert.equal(calls, 1);
  assert.deepEqual(bvids(again), bvids(first));
  assert.notEqual(again.candidates[0].id, first.candidates[0].id);
});
test("search snapshots are isolated by owner, query, source, page size and login context", async () => {
  setup(); const provider: SearchProvider = { name: "owner-test", searchVideos: async () => [song(1)] };
  const original = { ...base, appOwnerId: "one", sessionKey: "account-a", searchProvider: provider };
  const first = await runSearch(original);
  for (const change of [{ appOwnerId: "two" }, { keyword: "different" }, { limit: 2 }, { sessionKey: "account-b" }, { useRemote: false }]) {
    await assert.rejects(runSearch({ ...original, ...change, searchId: first.searchId }), SearchSnapshotError);
  }
  getDatabase().prepare("UPDATE search_sessions SET expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", first.searchId);
  await assert.rejects(runSearch({ ...original, searchId: first.searchId }), SearchSnapshotError);
});
test("concurrent requests to the same page share one fetch and stable response", async () => {
  setup(); let calls = 0;
  const provider: SearchProvider = { name: "concurrent-test", searchVideos: async (_key, options) => { calls++; await Promise.resolve(); return [song(options.page)]; } };
  const first = await runSearch({ ...base, searchProvider: provider });
  const next = { ...base, page: 2, searchId: first.searchId, searchProvider: provider };
  const results = await Promise.all([runSearch(next), runSearch(next)]);
  assert.equal(calls, 2);
  assert.deepEqual(bvids(results[0]), bvids(results[1]));
});
test("failure never overwrites a successful page and retry keeps the snapshot ID", async () => {
  setup(); let fail = true;
  const provider: SearchProvider = { name: "failure-test", searchVideos: async (_key, options) => {
    if (options.page === 2 && fail) throw new Error("temporary");
    return [song(options.page)];
  } };
  const first = await runSearch({ ...base, searchProvider: provider });
  await assert.rejects(runSearch({ ...base, page: 2, searchId: first.searchId, searchProvider: provider }), /temporary/);
  assert.deepEqual(bvids(await runSearch({ ...base, searchId: first.searchId, searchProvider: provider })), bvids(first));
  fail = false;
  assert.equal((await runSearch({ ...base, page: 2, searchId: first.searchId, searchProvider: provider })).searchId, first.searchId);
});
test("all-duplicate pages remain navigable rather than being filled from another page", async () => {
  setup(); const provider: SearchProvider = { name: "repeat-test", searchVideos: async () => [], searchPage: async () => ({ results: [song(1)], hasNextPage: true, totalPages: 10 }) };
  const first = await runSearch({ ...base, searchProvider: provider });
  const second = await runSearch({ ...base, page: 2, searchId: first.searchId, searchProvider: provider });
  assert.equal(second.candidates.length, 0); assert.equal(second.hasNextPage, true);
});
test("page links and jump attempts preserve the snapshot ID and login context", () => {
  const result = bindSearchResult({ keyword: "music", provider: "auto", useRemote: true, limit: 20, page: 1 }, {
    source: "remote", provider: "kernel", page: 1, limit: 20, hasNextPage: true, candidates: [],
    searchId: "snapshot", sessionKey: "account", pageLimit: 8,
  });
  const next = pageAttempt(result, 7);
  assert.equal(next.page, 7); assert.equal(next.searchId, "snapshot"); assert.equal(next.sessionKey, "account");
  assert.equal(searchEntry(searchUrl(next).split("?")[1]).request.searchId, "snapshot");
  assert.equal(pageAttempt(result, 100).page, 8);
});
test("numeric controls expose first, current and last pages without duplicates", () => {
  for (let page = 1; page <= 10; page++) {
    const pages = pageNumbers(page, 10).filter((item): item is number => typeof item === "number");
    assert.ok(pages.includes(1) && pages.includes(page) && pages.includes(10));
    assert.equal(new Set(pages).size, pages.length);
  }
  assert.deepEqual(pageNumbers(2, 3), [1, 2, 3]);
  assert.equal(pageLimit(50), 10); assert.equal(pageLimit(0), 1);
  assert.equal(validTotalPages("5"), 5); assert.equal(validTotalPages(null), undefined);
  assert.equal(validTotalPages(0, 20), undefined); assert.equal(validTotalPages(true), undefined);
});
