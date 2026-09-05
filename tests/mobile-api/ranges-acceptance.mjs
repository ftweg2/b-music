// Independent phone/web HTTP clients; no App/kernel module or DB imports.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
const base="http://127.0.0.1:3100",kernel="http://127.0.0.1:8100";
const report={id:randomUUID(),startedAt:new Date().toISOString(),requests:[],checks:[]};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(method,url,body,expected=200,headers={}){
  const id=randomUUID();const started=performance.now();
  const response=await fetch(base+url,{method,headers:{"content-type":"application/json","x-request-id":id,...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(40000)});
  const data=await response.json();
  report.requests.push({method,url,id,status:response.status,ms:Math.round(performance.now()-started)});
  assert.equal(response.status,expected,url+" "+JSON.stringify(data));
  assert.equal(response.headers.get("x-request-id"),id);
  if(expected>=400){assert.equal(typeof data.code,"string");assert.equal(typeof data.retryable,"boolean");}
  return data;
}
const get=(url,headers)=>api("GET",url,undefined,200,headers);
const post=(url,body,expected=200,headers)=>api("POST",url,body,expected,headers);
async function fixture(url,body){
  const response=await fetch(kernel+"/__fixture/"+url,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200);return response.json();
}
async function until(read,test,label){
  const end=Date.now()+35000;
  do{const data=await read();if(test(data))return data;await wait(200);}while(Date.now()<end);
  throw new Error("Timed out: "+label);
}
async function login(uid){
  await post("/api/kernel/login/logout",{confirmed:true});
  await fixture("control",{uid:null});
  await post("/api/kernel/login/start");
  await fixture("control",{uid});
  const status=await until(()=>get("/api/kernel/login/status"),s=>s.loggedIn&&s.biliUid===uid,"login "+uid);
  await until(()=>fixture("state"),s=>s.locks===0,"login cleanup");
  assert.equal(status.libraryMode,"account");assert.equal(status.appOwnerId,"bili:"+uid);
  return status;
}
const ownerA="bili:111111",ownerB="bili:222222",bvid="BV1test00001";
const resource="/api/playback-ranges/"+bvid;
let a;
try{
  await until(()=>fixture("state").catch(()=>null),s=>s?.fixture==="isolated-only","startup");
  a=await login("111111");
  const webHeaders={origin:base,"x-account-context":a.sessionKey};
  const phoneHeaders={"x-account-context":a.sessionKey};
  const search=await post("/api/search",{keyword:"Fixture Music",useRemote:true,provider:"bilibili",limit:20});
  const song=search.candidates.find(c=>c.bvid===bvid);assert.ok(song);
  const initial=(await get(resource,phoneHeaders)).playbackRange;
  assert.equal(initial.accountId,ownerA);assert.equal(initial.startSeconds,0);assert.equal(initial.endSeconds,null);
  for(let round=0;round<20;round++){
    const baseRange=(await get(resource,webHeaders)).playbackRange;
    const body={startSeconds:1+round/100,endSeconds:8,expectedRevision:baseRange.revision,expectedAccountId:ownerA};
    const results=await Promise.all(Array.from({length:6},()=>api("PATCH",resource,body,200,phoneHeaders)));
    assert.equal(new Set(results.map(r=>r.playbackRange.revision)).size,1);
    const fromWeb=(await get(resource,webHeaders)).playbackRange;
    assert.deepEqual(fromWeb,results[0].playbackRange);
    const conflict=await api("PATCH",resource,{...body,startSeconds:body.startSeconds+0.01},409,webHeaders);
    assert.equal(conflict.code,"PLAYBACK_RANGE_CONFLICT");
  }
  report.checks.push({name:"20 rounds: phone writes, web reads, six retries share one revision, stale writes rejected",passed:true});
  let current=(await get(resource)).playbackRange;
  for(const invalid of [{startSeconds:-1,endSeconds:8},{startSeconds:8,endSeconds:2},{startSeconds:0,endSeconds:13},{startSeconds:"2",endSeconds:8}])await api("PATCH",resource,{...invalid,expectedRevision:current.revision,expectedAccountId:ownerA},400,phoneHeaders);
  current=(await api("PATCH",resource,{startSeconds:2,endSeconds:5,expectedRevision:current.revision,expectedAccountId:ownerA},200,webHeaders)).playbackRange;
  assert.deepEqual((await get(resource,phoneHeaders)).playbackRange,current);
  await post("/api/favorites",{candidateId:song.id},201,webHeaders);
  const playlist=(await post("/api/playlists",{name:"Account A range playlist",candidateId:song.id},201,phoneHeaders)).playlist;
  await post("/api/creators",{biliMid:"4242",name:"Account A UP"},201,phoneHeaders);
  const b=await login("222222");
  const other=(await get(resource,{"x-account-context":b.sessionKey,cookie:"bili_music_owner_id=bili:111111"})).playbackRange;
  assert.equal(other.accountId,ownerB);assert.equal(other.revision,0);assert.equal(other.configured,false);
  assert.equal((await get("/api/favorites")).items.length,0);
  assert.equal((await get("/api/playlists")).playlists.length,0);
  assert.equal((await get("/api/creators")).creators.length,0);
  await api("GET","/api/playlists/"+playlist.id,undefined,404);
  const stale=await api("PATCH",resource,{startSeconds:3,endSeconds:6,expectedRevision:current.revision,expectedAccountId:ownerA},409,webHeaders);
  assert.equal(stale.code,"ACCOUNT_CHANGED");
  await post("/api/kernel/login/logout",{confirmed:true},409,webHeaders);
  await post("/api/kernel/login/start",undefined,409,webHeaders);
  assert.equal((await get("/api/kernel/login/status")).biliUid,"222222");
  await api("PATCH",resource,{startSeconds:4,endSeconds:9,expectedRevision:0,expectedAccountId:ownerB});
  a=await login("111111");
  assert.deepEqual((await get(resource)).playbackRange,current);
  assert.equal((await get("/api/favorites")).items.length,1);
  assert.equal((await get("/api/playlists/"+playlist.id)).playlist.id,playlist.id);
  assert.equal((await get("/api/creators")).creators.length,1);
  report.checks.push({name:"two verified Bilibili identities isolate ranges and libraries; switching back restores A; cookies cannot select owner",passed:true});
  const prepared=(await post("/api/tracks/prepare",{candidateId:song.id,strategyMode:"force",strategy:"browser_network"})).track;
  const ready=(await until(()=>get("/api/tracks/"+prepared.id),s=>s.track.status!=="preparing","audio ready")).track;
  assert.equal(ready.status,"ready",ready.failureReason);assert.deepEqual(ready.playbackRange,current);
  assert.equal((await post("/api/tracks/status",{trackIds:[ready.id]})).tracks[0].playbackRange.startSeconds,2);
  assert.equal((await get("/api/tracks")).tracks[0].playbackRange.endSeconds,5);
  const reset=(await api("PATCH",resource,{startSeconds:0,endSeconds:null,expectedRevision:current.revision,expectedAccountId:ownerA})).playbackRange;
  assert.equal(reset.configured,false);
  current=(await api("PATCH",resource,{startSeconds:2,endSeconds:5,expectedRevision:reset.revision,expectedAccountId:ownerA})).playbackRange;
  assert.equal((await get("/api/tracks/"+ready.id)).track.playbackRange.revision,current.revision);
  const cors=await fetch(base+resource,{method:"OPTIONS",headers:{origin:"capacitor://localhost","access-control-request-method":"PATCH","access-control-request-headers":"content-type,x-account-context"}});
  assert.equal(cors.status,204);assert.match(cors.headers.get("access-control-allow-headers"),/X-Account-Context/);
  report.checks.push({name:"prepare, single/batch/list track APIs expose the latest shared range; reset persists; WebView preflight works",passed:true});
  report.uiFixture={bvid,candidateId:song.id,trackId:ready.id,accountId:ownerA,startSeconds:2,endSeconds:5};
  report.passed=true;
}catch(error){report.passed=false;report.failure=error.message;console.error(error);process.exitCode=1;}
finally{
  report.finishedAt=new Date().toISOString();
  const directory=path.join(import.meta.dirname,"reports");await mkdir(directory,{recursive:true});
  const file=path.join(directory,report.id+"-ranges.json");await writeFile(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,requests:report.requests.length,checks:report.checks,uiFixture:report.uiFixture,report:file}));
}
