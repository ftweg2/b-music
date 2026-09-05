import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { closeDatabaseForTests, getDatabase, createOrReuseTrack } from "../lib/db";
import { normalizeRawSearchResult, saveCandidateMetadata } from "../lib/search/cache";
import { readPlaybackRanges, savePlaybackRange } from "../lib/playbackRanges";
import { toTrackApiResource, toTrackApiResources } from "../lib/trackApi";

test("batched track serialization preserves exact output, order, defaults and owner isolation",()=>{
  closeDatabaseForTests();process.env.DATABASE_PATH=path.join(os.tmpdir(),"batch-parity-"+crypto.randomUUID()+".sqlite");
  const songs=[1,2].map(i=>saveCandidateMetadata(normalizeRawSearchResult({bvid:"BV1test0000"+i,title:"batch "+i,durationSeconds:200},"batch","test")));
  const tracks=[createOrReuseTrack(songs[0],"bili:1"),createOrReuseTrack(songs[0],"bili:2"),createOrReuseTrack(songs[1],"bili:1")];
  savePlaybackRange(songs[0].bvid,"bili:1",{startSeconds:10,endSeconds:180,expectedRevision:0,expectedAccountId:"bili:1"});
  savePlaybackRange(songs[0].bvid,"bili:2",{startSeconds:20,endSeconds:null,expectedRevision:0,expectedAccountId:"bili:2"});
  assert.deepEqual(toTrackApiResources(tracks),tracks.map(toTrackApiResource));
  assert.deepEqual(toTrackApiResources([]),[]);
  assert.equal(readPlaybackRanges([songs[0].bvid,songs[0].bvid],"bili:1").size,1);
  savePlaybackRange(songs[0].bvid,"bili:1",{startSeconds:11,endSeconds:180,expectedRevision:1,expectedAccountId:"bili:1"});
  assert.equal(toTrackApiResources(tracks)[0].playbackRange.startSeconds,11);
  const plan=getDatabase().prepare("EXPLAIN QUERY PLAN SELECT * FROM tracks WHERE external_owner_id=? AND status=? ORDER BY updated_at DESC,id DESC LIMIT 51").all("bili:1","ready").map(row=>String(row.detail));
  assert.ok(plan.some(line=>line.includes("idx_tracks_owner_status_recency")));assert.ok(plan.every(line=>!line.includes("TEMP B-TREE")));
  closeDatabaseForTests();
});
