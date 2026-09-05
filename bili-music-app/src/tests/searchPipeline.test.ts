import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { closeDatabaseForTests, getDatabase, createPreferredCreator, createFavoriteVideo, listFavoriteVideos, searchLocalCandidates, getCandidateByBvid } from "../lib/db";
import { normalizeRawSearchResult, runSearch, saveCandidateMetadata, toCandidateItem } from "../lib/search/cache";
import { bilibiliProvider } from "../lib/search/bilibiliProvider";
import { resetRateLimitsForTests } from "../lib/rateLimit";
import type { RawSearchResult, SearchProvider } from "../lib/search/types";

function database() {
  closeDatabaseForTests();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `b-music-polish-${crypto.randomUUID()}.sqlite`);
  delete process.env.BILIBILI_SEARCH_LIMIT;
  resetRateLimitsForTests();
}
function raw(bvid = "BV1test00001", title = "piano live"): RawSearchResult {
  return { bvid, title, creatorMid: "111", creatorName: "Piano UP", durationSeconds: 240 };
}
function save(item: RawSearchResult) { return saveCandidateMetadata(normalizeRawSearchResult(item, "piano", "test")); }
function provider(items: RawSearchResult[], more = false): SearchProvider {
  return { name: "test", searchVideos: async () => items, searchPage: async () => ({ results: items, hasNextPage: more }) };
}

test("online search prioritizes followed creators without scores or cache mixing", async () => {
  database();
  save(raw("BV1test00003", "cached piano"));
  createPreferredCreator({ biliMid: "222", name: "Followed" });
  const first = raw();
  const second = { ...raw("BV1test00002"), creatorMid: "222" };
  const result = await runSearch({ keyword: "piano", useRemote: true, limit: 20, searchProvider: provider([first, second]) });
  assert.deepEqual(result.candidates.map((item) => item.bvid), [second.bvid, first.bvid]);
  assert.equal(result.candidates[0].isPreferredCreator, true);
  assert.equal(result.candidates[1].isPreferredCreator, false);
  assert.equal(result.hasNextPage, false);
  assert.equal(result.source, "remote");
  assert.equal(Object.keys(result.candidates[0]).some((key) => /score|boost|weight/i.test(key)), false);
});

test("one invalid result and duplicates do not discard the rest of a page", async () => {
  database();
  const result = await runSearch({ keyword: "piano", useRemote: true, limit: 20,
    searchProvider: provider([raw(), raw("invalid"), raw(), raw("BV1test00002")]) });
  assert.equal(result.candidates.length, 2);
});

test("remote failures preserve source and record failure instead of returning local substitutes", async () => {
  database(); save(raw());
  await assert.rejects(runSearch({ keyword: "piano", useRemote: true, limit: 20, page: 2, searchProvider: {
    name: "unavailable", searchVideos: async () => { throw new Error("provider offline"); }
  } }), /offline/);
  const log = getDatabase().prepare("SELECT provider,page,error_message FROM search_query_logs ORDER BY id DESC LIMIT 1").get();
  assert.equal(log?.provider, "unavailable");
  assert.equal(log?.page, 2);
  assert.match(String(log?.error_message), /offline/);
});

test("a successful empty remote result stays empty instead of substituting old music", async () => {
  database(); save(raw());
  const result = await runSearch({ keyword: "piano", useRemote: true, limit: 20, searchProvider: provider([]) });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.remoteUsed, true);
});

test("local search matches all words, handles literal wildcards and excludes empty searches", () => {
  database();
  save(raw()); save(raw("BV1test00002", "piano solo")); save({ ...raw("BV1test00003", "100%_live"), creatorName: "Other" });
  assert.equal(searchLocalCandidates("piano live", 20).length, 1);
  assert.equal(searchLocalCandidates("%_", 20).length, 1);
  assert.equal(searchLocalCandidates("", 20).length, 0);
});

test("local pagination uses a sentinel and stable IDs for timestamp ties", async () => {
  database(); save(raw()); save(raw("BV1test00002")); save(raw("BV1test00003"));
  const request = { keyword: "piano", useRemote: false, limit: 2, searchProvider: provider([]) };
  const first = await runSearch(request);
  const second = await runSearch({ ...request, page: 2 });
  assert.equal(first.hasNextPage, true);
  assert.equal(second.hasNextPage, false);
  assert.equal(second.candidates.length, 1);
  assert.equal(new Set([...first.candidates, ...second.candidates].map((item) => item.id)).size, 3);
});

test("remote page size reflects provider capacity instead of skipping results", async () => {
  database();
  let received = 0;
  const result = await runSearch({ keyword: "piano", useRemote: true, limit: 50,
    searchProvider: { name: "limited", maxPageSize: 20, searchVideos: async (_key, options) => { received = options.limit; return []; } } });
  assert.equal(received, 20);
  assert.equal(result.limit, 20);
});

test("direct BV links need no remote search and local-only lookup does not create records", async () => {
  database(); let calls = 0;
  const direct = "BV1test00001";
  const source = { name: "test", searchVideos: async () => { calls++; return []; } };
  const local = await runSearch({ keyword: direct, useRemote: false, limit: 20, searchProvider: source });
  assert.equal(local.candidates.length, 0);
  assert.equal(getCandidateByBvid(direct), null);
  const selected = await runSearch({ keyword: `https://www.bilibili.com/video/${direct}`, useRemote: true, limit: 20, searchProvider: source });
  assert.equal(selected.source, "direct");
  assert.equal(selected.candidates.length, 1);
  assert.equal(calls, 0);
});

test("sparse metadata does not erase covers, creators, duration or tags", () => {
  database();
  const full = save({ ...raw(), tags: ["piano"], coverUrl: "https://i0.hdslb.com/bfs/archive/example.jpg" });
  save({ bvid: full.bvid, title: `Bilibili 视频 ${full.bvid}` });
  const saved = getCandidateByBvid(full.bvid)!;
  assert.equal(saved.title, full.title);
  assert.equal(saved.coverUrl, full.coverUrl);
  assert.equal(saved.durationSeconds, 240);
  assert.deepEqual(toCandidateItem(saved).tags, ["piano"]);
});

test("favoriting again preserves notes, mood, creation time and owner separation", () => {
  database(); const candidate = save(raw());
  const first = createFavoriteVideo(candidate.id, { externalOwnerId: "one", note: "keep this", mood: "calm" });
  const again = createFavoriteVideo(candidate.id, { externalOwnerId: "one" });
  assert.equal(again.note, "keep this");
  assert.equal(again.mood, "calm");
  assert.equal(again.createdAt, first.createdAt);
  assert.equal(listFavoriteVideos(10, "two").length, 0);
});

test("legacy score columns are tolerated but never exposed or updated", () => {
  database(); const candidate = save(raw());
  getDatabase().exec("ALTER TABLE candidate_videos ADD COLUMN final_score REAL NOT NULL DEFAULT 99");
  getDatabase().exec("ALTER TABLE preferred_creators ADD COLUMN priority_weight INTEGER NOT NULL DEFAULT 50");
  closeDatabaseForTests();
  const item = getCandidateByBvid(candidate.bvid)!;
  assert.equal("finalScore" in item, false);
  assert.equal(save(raw()).id, candidate.id);
  assert.equal(getDatabase().prepare("SELECT final_score FROM candidate_videos WHERE id=?").get(candidate.id)?.final_score, 99);
});

test("explicitly clearing favorite notes is distinct from repeated favorite clicks", () => {
  database(); const candidate = save(raw());
  createFavoriteVideo(candidate.id, { note: "keep", mood: "calm" });
  const updated = createFavoriteVideo(candidate.id, { note: null });
  assert.equal(updated.note, null);
  assert.equal(updated.mood, "calm");
});

test("canonical source links exclude arbitrary hosts and malformed timestamps", () => {
  const item = normalizeRawSearchResult({ ...raw(), sourceUrl: "https://evil.example/anything", pubTime: 1e50 }, "piano", "test");
  assert.equal(item.sourceUrl, "https://www.bilibili.com/video/BV1test00001");
  assert.equal(item.pubTime, null);
});

test("Bilibili business errors do not masquerade as empty success", async () => {
  database(); const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ code: -412, message: "blocked", data: { result: [] } });
  try { await assert.rejects(bilibiliProvider.searchVideos("piano", { limit: 20, page: 1, timeoutMs: 1000 }), /blocked/); }
  finally { globalThis.fetch = original; }
});

test("Bilibili pagination uses upstream page metadata including a full final page", async () => {
  database(); const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ code: 0, data: { numPages: 1, result: [{ bvid: raw().bvid, title: "piano", pic: "//i0.hdslb.com/bfs/archive/example.jpg" }] } });
  try {
    const result = await bilibiliProvider.searchPage!("piano", { limit: 1, page: 1, timeoutMs: 1000 });
    assert.equal(result.hasNextPage, false);
    assert.match(result.results[0].coverUrl!, /^https:/);
  } finally { globalThis.fetch = original; }
});
