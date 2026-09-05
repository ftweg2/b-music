// Limited, non-destructive smoke test of the existing local installation.
// Never logs out, deletes library metadata, or reads browser credentials.
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
const base="http://127.0.0.1:3000";
const directory=path.join(import.meta.dirname,"mobile-api/reports");
const checkpoint=path.join(directory,"live-deployment-checkpoint.json");
await mkdir(directory,{recursive:true});
const report={startedAt:new Date().toISOString(),mode:process.argv[2],requests:[],checks:[]};
const hash=(value)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function api(url,body) {
  const id=randomUUID(),started=performance.now();
  const response=await fetch(base+url,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json","x-request-id":id,origin:base},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  const data=await response.json();
  report.requests.push({url,id,status:response.status,ms:Math.round(performance.now()-started)});
  assert.ok(response.ok,url+": "+data.error);
  return data;
}
async function snapshot() {
  const status=await api("/api/kernel/login/status");
  const playlists=await api("/api/playlists");
  const favorites=await api("/api/favorites?limit=100");
  const creators=await api("/api/creators");
  return {sessionFingerprint:hash(status.sessionKey),loggedIn:status.loggedIn,
    libraryFingerprint:hash([playlists.playlists,favorites.favorites,creators.creators]),
    playlists:playlists.playlists.length,favorites:favorites.favorites.length,creators:creators.creators.length};
}
try {
  if(process.argv[2]==="before") {
    const current=await snapshot();
    await writeFile(checkpoint,JSON.stringify(current,null,2));
    report.checks.push({name:"pre-deployment metadata fingerprint",...current});
  } else if(process.argv[2]==="after") {
    const before=JSON.parse(await readFile(checkpoint,"utf8"));
    const after=await snapshot();
    assert.deepEqual(after,before,"deployment must preserve session and saved library");
    await api("/api/health"); await api("/api/kernel/health");
    report.checks.push({name:"deployment preserved login and saved library",...after});
    const search=await api("/api/search",{keyword:"纯音乐",useRemote:true,provider:after.loggedIn?"kernel":"bilibili",page:1,limit:20});
    assert.ok(search.candidates.length,"real upstream search returned no candidates");
    const candidates=await api("/api/candidates?limit=100");
    const existing=await api("/api/tracks?limit=100");
    // Use a short existing candidate without forcing renewal of an already
    // ready user's track. One explicit preparation is enough for a smoke test.
    const candidate=[...candidates.candidates].filter(c=>c.durationSeconds>=10&&c.durationSeconds<=300)
      .filter(c=>!existing.tracks.some(t=>t.bvid===c.bvid&&["ready","preparing"].includes(t.status)))
      .sort((a,b)=>a.durationSeconds-b.durationSeconds)[0];
    assert.ok(candidate,"No suitable existing unprepared short candidate; no automatic batch extraction");
    const prepared=await api("/api/tracks/prepare",{candidateId:candidate.id});
    assert.equal(prepared.track.status,"preparing",prepared.track.failureReason);
    let ready=prepared.track;
    const pages=[];
    for(const page of [2,5]) {
      const beforePage=(await api("/api/tracks/"+ready.id)).track;
      const result=await api("/api/search",{keyword:"纯音乐",useRemote:true,provider:search.provider,page,limit:search.limit,searchId:search.searchId,sessionKey:search.sessionKey});
      pages.push({page,count:result.candidates.length,statusBefore:beforePage.status});
    }
    assert.ok(pages.some(p=>p.statusBefore==="preparing"),"audio finished before concurrent page request; parallel proof remains fixture-only");
    const deadline=Date.now()+240000;
    while(ready.status==="preparing"&&Date.now()<deadline) {
      await new Promise(resolve=>setTimeout(resolve,1500));
      ready=(await api("/api/tracks/"+ready.id)).track;
    }
    assert.equal(ready.status,"ready",ready.failureReason||"audio preparation did not finish in time");
    const downloaded=await fetch(base+ready.media.downloadUrl,{signal:AbortSignal.timeout(60000)});
    assert.equal(downloaded.status,200);
    const audio=Buffer.from(await downloaded.arrayBuffer());
    assert.equal(createHash("sha256").update(audio).digest("hex"),ready.media.checksum.value);
    const ranged=await fetch(base+ready.media.streamUrl,{headers:{range:"bytes=0-255"},signal:AbortSignal.timeout(15000)});
    assert.equal(ranged.status,206);
    assert.equal((await ranged.arrayBuffer()).byteLength,256);
    report.checks.push({name:"real preparation + fresh pages + verified audio",pages,trackId:ready.id,size:audio.length,checksumVerified:true});
    const final=await snapshot();
    assert.equal(final.sessionFingerprint,before.sessionFingerprint);
    assert.equal(final.libraryFingerprint,before.libraryFingerprint);
  } else throw new Error("Use before or after");
  report.passed=true;
} catch(error) {report.passed=false;report.failure=error.message;console.error(error);process.exitCode=1;}
finally {
  report.finishedAt=new Date().toISOString();
  const file=path.join(directory,randomUUID()+"-live-"+process.argv[2]+".json");
  await writeFile(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,checks:report.checks,report:file}));
}
