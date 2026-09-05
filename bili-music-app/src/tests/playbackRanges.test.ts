import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { closeDatabaseForTests, getDatabase, createPreferredCreator, createFavoriteVideo, createOrReuseTrack } from "../lib/db";
import { normalizeRawSearchResult, saveCandidateMetadata } from "../lib/search/cache";
import { readPlaybackRange, savePlaybackRange } from "../lib/playbackRanges";
import { parsePlaybackTime, formatPlaybackTime, effectivePlaybackRange, playbackResumeTime } from "../lib/playbackRange";
import { attachPlaybackBoundary, rangeMediaUrl } from "../lib/playbackBoundary";
import { accountLibraryEnabled } from "../lib/ownerIdentity";
import { migrateLegacyLibrary } from "../lib/accountLibrary";
import { createPlaylist, getPlaylist } from "../lib/playlists";
import { GET, PATCH } from "../app/api/playback-ranges/[bvid]/route";
import { GET as candidates } from "../app/api/candidates/route";

const bv="BV1test00003";
function setup() {
  closeDatabaseForTests();
  process.env.DATABASE_PATH=path.join(os.tmpdir(),`playback-range-${crypto.randomUUID()}.sqlite`);
  process.env.APP_LIBRARY_MODE="local"; process.env.APP_OWNER_ID="local";
  return saveCandidateMetadata(normalizeRawSearchResult({bvid:bv,title:"range",durationSeconds:180,creatorMid:"123"},"range","test"));
}
const input=(startSeconds:number,endSeconds:number|null,expectedRevision=0,expectedAccountId="bili:111")=>({startSeconds,endSeconds,expectedRevision,expectedAccountId});

test("production defaults to verified account ownership, ignoring the old single-user flag",()=>{
  const mode=process.env.APP_LIBRARY_MODE;
  delete process.env.APP_LIBRARY_MODE;process.env.APP_SINGLE_USER_MODE="1";
  try{assert.equal(accountLibraryEnabled(),true);}finally{if(mode===undefined)delete process.env.APP_LIBRARY_MODE;else process.env.APP_LIBRARY_MODE=mode;}
});

test("playback ranges use account + BV and survive metadata deletion and database reopen",()=>{
  setup();
  assert.deepEqual([readPlaybackRange(bv,"bili:111").startSeconds,readPlaybackRange(bv,"bili:111").endSeconds],[0,null]);
  const saved=savePlaybackRange(bv,"bili:111",input(12.25,145.5));
  assert.equal(saved.revision,1); assert.equal(saved.configured,true);
  assert.equal(readPlaybackRange(bv,"bili:222").configured,false);
  getDatabase().prepare("DELETE FROM candidate_videos WHERE bvid=?").run(bv);
  closeDatabaseForTests();
  assert.deepEqual(readPlaybackRange(bv,"bili:111"),saved);
});
test("range updates reject stale editors and safely replay the same acknowledged write",()=>{
  setup();
  const first=savePlaybackRange(bv,"bili:111",input(10,100));
  assert.deepEqual(savePlaybackRange(bv,"bili:111",input(10,100)),first);
  assert.throws(()=>savePlaybackRange(bv,"bili:111",input(11,100)),/其他设备/);
  const second=savePlaybackRange(bv,"bili:111",input(11,null,1));
  assert.equal(second.revision,2);
  const reset=savePlaybackRange(bv,"bili:111",input(0,null,2));
  assert.equal(reset.revision,3); assert.equal(reset.configured,false);
  assert.throws(()=>savePlaybackRange(bv,"bili:111",input(12,100,1)),/其他设备/);
});
test("invalid, nonfinite, reversed, stale-account and out-of-duration ranges cannot be saved",()=>{
  setup();
  for(const body of [input(-1,20),input(20,20),input(20,19),input(NaN,null),input(0,Infinity),input(180,null),input(0,181),{...input(0,30),startSeconds:"10"},{...input(0,30),endSeconds:undefined},input(0,20,0,"bili:222")]) {
    assert.throws(()=>savePlaybackRange(bv,"bili:111",body));
  }
  assert.equal(readPlaybackRange(bv,"bili:111").revision,0);
});
test("range time parsing and effective boundaries never allow an invalid start",()=>{
  assert.equal(parsePlaybackTime("1:02.125"),62.125);
  assert.equal(parsePlaybackTime("01:02:03"),3723);
  assert.equal(parsePlaybackTime(""),null);
  for(const text of ["-1","1:60","NaN","1.1234","1:2:3:4"])assert.ok(Number.isNaN(parsePlaybackTime(text)));
  assert.equal(formatPlaybackTime(62.125),"1:02.125");
  assert.deepEqual(effectivePlaybackRange({startSeconds:10,endSeconds:100},80),{start:10,end:80,valid:true,stopAtEnd:true});
  assert.equal(effectivePlaybackRange({startSeconds:80,endSeconds:null},80).valid,false);
  assert.equal(playbackResumeTime({startSeconds:3,endSeconds:7},12,6.959999),3);
  assert.equal(playbackResumeTime({startSeconds:3,endSeconds:7},12,4),4);
});

test("playback enforcement seeks to start, stops at custom end and releases listeners",()=>{
  class Audio extends EventTarget {
    currentTime=0;duration=12;paused=true;playbackRate=1;
    pause(){this.paused=true;this.dispatchEvent(new Event("pause"));}
    play(){this.paused=false;this.dispatchEvent(new Event("play"));}
  }
  const audio=new Audio();
  const range={accountId:"bili:111",bvid:bv,startSeconds:2,endSeconds:5,revision:1,updatedAt:null,configured:true};
  let ended=0;
  const detach=attachPlaybackBoundary(audio,range,invalid=>{assert.equal(invalid,false);ended++;});
  assert.equal(audio.currentTime,2);
  audio.play();audio.currentTime=7;audio.dispatchEvent(new Event("seeked"));
  assert.equal(audio.currentTime,5);assert.equal(audio.paused,true);assert.equal(ended,1);
  audio.dispatchEvent(new Event("timeupdate"));assert.equal(ended,1);
  audio.currentTime=2;audio.play();audio.currentTime=5;audio.dispatchEvent(new Event("timeupdate"));
  assert.equal(ended,2);
  detach();audio.currentTime=1;audio.dispatchEvent(new Event("timeupdate"));assert.equal(audio.currentTime,1);
  assert.equal(rangeMediaUrl("/api/tracks/1/stream",range),"/api/tracks/1/stream#t=2,5");
});

test("invalid duration stops playback instead of falling back to noisy original start",()=>{
  class Audio extends EventTarget {currentTime=0;duration=1;paused=false;playbackRate=1;pause(){this.paused=true;}}
  const audio=new Audio();let invalid=false;
  const detach=attachPlaybackBoundary(audio,{accountId:"bili:111",bvid:bv,startSeconds:2,endSeconds:5,revision:1,updatedAt:null,configured:true},bad=>{invalid=bad;});
  assert.equal(invalid,true);assert.equal(audio.paused,true);detach();
});
test("legacy library migration preserves record IDs and kernel ownership and runs only once",()=>{
  const song=setup();
  const favorite=createFavoriteVideo(song.id);
  const creator=createPreferredCreator({biliMid:"123",name:"original"});
  const track=createOrReuseTrack(song);
  getDatabase().prepare("UPDATE tracks SET kernel_owner_id=? WHERE id=?").run("local",track.id);
  const playlist=createPlaylist("local",{name:"legacy",candidateId:song.id});
  savePlaybackRange(bv,"local",input(10,100,0,"local"));
  migrateLegacyLibrary("local","bili:111");
  assert.equal(getDatabase().prepare("SELECT external_owner_id FROM favorite_videos WHERE id=?").get(favorite.id)?.external_owner_id,"bili:111");
  assert.equal(getDatabase().prepare("SELECT external_owner_id FROM preferred_creators WHERE id=?").get(creator.id)?.external_owner_id,"bili:111");
  assert.equal(getDatabase().prepare("SELECT kernel_owner_id FROM tracks WHERE id=?").get(track.id)?.kernel_owner_id,"local");
  assert.equal(getPlaylist(playlist.id,"bili:111").id,playlist.id);
  assert.equal(readPlaybackRange(bv,"bili:111").startSeconds,10);
  migrateLegacyLibrary("local","bili:222");
  assert.throws(()=>getPlaylist(playlist.id,"bili:222"));
});

test("migration collisions keep both records and never donate leftovers to another account",()=>{
  const song=setup();
  const legacy=createFavoriteVideo(song.id,{externalOwnerId:"local",note:"legacy note"});
  const account=createFavoriteVideo(song.id,{externalOwnerId:"bili:111",note:"account note"});
  migrateLegacyLibrary("local","bili:111");migrateLegacyLibrary("local","bili:222");
  const rows=getDatabase().prepare("SELECT id,external_owner_id,note FROM favorite_videos ORDER BY id").all();
  assert.equal(rows.length,2);
  assert.equal(rows.find(row=>row.id===legacy.id)?.external_owner_id,"local");
  assert.equal(rows.find(row=>row.id===account.id)?.note,"account note");
  assert.equal(rows.some(row=>row.external_owner_id==="bili:222"||row.external_owner_id==="guest:local"),false);
});
test("API ownership comes from kernel identity, never cookies or a claimed owner",async()=>{
  setup(); process.env.APP_LIBRARY_MODE="account";
  const original=globalThis.fetch;
  let uid="111";
  globalThis.fetch=async(input)=>String(input).includes("/login/status")
    ? Response.json({profile_id:"p_test",logged_in:true,bili_uid:uid,last_verified_at:"2026-09-05T00:00:00Z"})
    : Response.json({profile_id:"p_test",external_owner_id:"local",status:"exists"});
  const context={params:Promise.resolve({bvid:bv})};
  try {
    const read=await GET(new Request("http://localhost/api/playback-ranges/"+bv),context);
    const range=(await read.json()).playbackRange;
    assert.equal(range.accountId,"bili:111");
    const token=read.headers.get("x-account-context")!;
    const request=(body:unknown)=>new Request("http://localhost/api/playback-ranges/"+bv,{method:"PATCH",headers:{"content-type":"application/json",cookie:"bili_music_owner_id=bili:111"},body:JSON.stringify(body)});
    assert.equal((await PATCH(request(input(10,100)),context)).status,200);
    uid="222";
    assert.equal((await PATCH(request(input(20,100,1)),context)).status,409);
    const other=(await (await GET(new Request("http://localhost/api/playback-ranges/"+bv),context)).json()).playbackRange;
    assert.equal(other.accountId,"bili:222"); assert.equal(other.configured,false);
    const stale=await candidates(new Request("http://localhost/api/candidates",{headers:{"x-account-context":token}}));
    assert.equal(stale.status,409); assert.equal((await stale.json()).code,"ACCOUNT_CHANGED");
    globalThis.fetch=async()=>{throw new Error("offline");};
    assert.equal((await GET(new Request("http://localhost/api/playback-ranges/"+bv),context)).status,503);
  } finally { globalThis.fetch=original;process.env.APP_LIBRARY_MODE="local"; }
});
