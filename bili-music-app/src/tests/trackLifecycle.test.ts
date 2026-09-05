import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { closeDatabaseForTests, getDatabase, createFavoriteVideo, createOrReuseTrack, claimTrackPreparation } from "../lib/db";
import { normalizeRawSearchResult, saveCandidateMetadata } from "../lib/search/cache";
import { getReusablePreparedTrack, getSyncedTrack, prepareTrack } from "../lib/tracks";

function setup() {
  closeDatabaseForTests();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `b-music-tracks-${crypto.randomUUID()}.sqlite`);
  return saveCandidateMetadata(normalizeRawSearchResult({ bvid: "BV1test00001", title: "piano" }, "piano", "test"));
}
test("track recovery never hydrates another owner's favorite snapshot", () => {
  const candidate = setup();
  createFavoriteVideo(candidate.id, { externalOwnerId: "local", note: "private" });
  getDatabase().prepare("DELETE FROM candidate_videos WHERE id=?").run(candidate.id);
  assert.throws(() => getReusablePreparedTrack({ bvid: candidate.bvid, appOwnerId: "someone-else" }), /候选视频不存在/);
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS count FROM candidate_videos").get()?.count, 0);
});
test("simultaneous status reads share a single kernel request", async () => {
  const candidate = setup();
  const track = createOrReuseTrack(candidate, "owner");
  claimTrackPreparation(track.id, "test-job", "owner", "kernel-owner");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ job_id: "test-job", status: "running_api_dash" }); };
  try {
    const results = await Promise.all([getSyncedTrack(track.id, "owner"), getSyncedTrack(track.id, "owner")]);
    assert.equal(calls, 1);
    assert.equal(results[0]?.status, "preparing");
    assert.equal(results[1]?.id, track.id);
  } finally { globalThis.fetch = original; }
});

test("explicit kernel admission rejection is retryable without creating an imaginary pending job", async () => {
  const candidate = setup();
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ detail: "kernel is busy; retry later" }, { status: 503, headers: { "x-kernel-job-accepted": "false", "retry-after": "3" } });
  try {
    const track = await prepareTrack({ candidateId: candidate.id, profileId: "test-profile", appOwnerId: "local", externalOwnerId: "kernel-owner" });
    assert.equal(track.status, "failed");
    assert.match(track.failureReason!, /busy/);
    assert.equal(getReusablePreparedTrack({ candidateId: candidate.id, appOwnerId: "local" }), null);
  } finally { globalThis.fetch = original; }
});
