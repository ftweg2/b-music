// Companion native HTTP checks. See README for the explicit fixture-only restart.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const app="http://127.0.0.1:3100", kernel="http://127.0.0.1:8100";
const mode=process.argv[2];
const directory=path.join(import.meta.dirname,"reports");
await mkdir(directory,{recursive:true});
const checkpoint=path.join(directory,"restart-checkpoint.json");
const report={mode,startedAt:new Date().toISOString(),requests:[],checks:[]};
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function http(base,url,body,status=200) {
  const id=randomUUID();
  const started=performance.now();
  const response=await fetch(base+url,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json","x-request-id":id},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(40000)});
  const data=await response.json();
  report.requests.push({url,id,status:response.status,ms:Math.round(performance.now()-started)});
  assert.ok((Array.isArray(status)?status:[status]).includes(response.status),url+" "+response.status+" "+JSON.stringify(data));
  return {data,response};
}
const api=async (url,body)=>(await http(app,url,body)).data;
const fixture=async (url,body)=>(await http(kernel,"/__fixture/"+url,body)).data;
async function until(action,predicate,label) {
  const end=Date.now()+35000;
  do {const value=await action();if(predicate(value))return value;await sleep(200);} while(Date.now()<end);
  throw new Error("Timed out: "+label);
}
try {
  await until(()=>fixture("state").catch(()=>null),(s)=>s?.fixture==="isolated-only","fixture startup");
  const identity=await api("/api/kernel/login/status");
  const saved=(await api("/api/tracks")).tracks[0];
  assert.ok(saved,"Run acceptance.mjs first");
  const refresh=()=>api("/api/tracks/"+saved.id+"/refresh",{strategyMode:"force",strategy:"browser_network"});
  if (mode==="cancel") {
    for (let round=0;round<3;round++) {
      await fixture("control",{hold_browser:true,hold_media:false});
      const track=(await refresh()).track;
      await until(()=>fixture("state"),(s)=>s.browser_stage,"capture before cancel");
      await http(kernel,"/v1/jobs/"+track.kernelJobId+"/cancel",{external_owner_id:"different-owner"},403);
      await http(kernel,"/v1/jobs/"+track.kernelJobId+"/cancel",{external_owner_id:identity.externalOwnerId});
      await until(()=>api("/api/tracks/"+saved.id),(s)=>s.track.status==="failed","cancel terminal state");
      const clean=await until(()=>fixture("state"),(s)=>!s.locks&&!s.readers&&!s.browsers&&!s.active_jobs,"cancel cleanup");
      report.checks.push({name:"cancel-round-"+round,clean});
    }
    await fixture("control",{hold_browser:false});
    await refresh();
    const recovered=await until(()=>api("/api/tracks/"+saved.id),(s)=>s.track.status!=="preparing","recovery after cancel");
    assert.equal(recovered.track.status,"ready",recovered.track.failureReason);
  } else if (mode==="before-restart") {
    const playlists=await api("/api/playlists"), favorites=await api("/api/favorites");
    await fixture("control",{hold_browser:true,hold_media:false});
    const track=(await refresh()).track;
    const state=await until(()=>fixture("state"),(s)=>s.browser_stage,"capture before forced restart");
    assert.equal(state.browsers,1);
    await writeFile(checkpoint,JSON.stringify({trackId:saved.id,jobId:track.kernelJobId,sessionKey:identity.sessionKey,playlists:playlists.playlists.map(p=>p.id),favorites:favorites.items.map(i=>i.favorite.bvid)}));
    report.checks.push({name:"active capture checkpoint",state});
  } else if (mode==="after-restart") {
    const before=JSON.parse(await readFile(checkpoint,"utf8"));
    assert.equal(identity.sessionKey,before.sessionKey,"login metadata retained");
    const track=(await api("/api/tracks/"+before.trackId)).track;
    assert.equal(track.kernelJobId,before.jobId);
    assert.equal(track.status,"failed","interrupted jobs must be terminal after startup");
    assert.deepEqual((await api("/api/playlists")).playlists.map(p=>p.id),before.playlists);
    assert.deepEqual((await api("/api/favorites")).items.map(i=>i.favorite.bvid),before.favorites);
    const state=await fixture("state");
    assert.equal(state.locks,0); assert.equal(state.readers,0); assert.equal(state.browsers,0);
    await refresh();
    const recovered=await until(()=>api("/api/tracks/"+before.trackId),(s)=>s.track.status!=="preparing","new Chrome after forced termination");
    assert.equal(recovered.track.status,"ready",recovered.track.failureReason);
    report.checks.push({name:"restart recovery preserves library and session; new Chrome succeeds",state,track:recovered.track.status});
  } else if (mode==="readers") {
    // Test a fresh isolated owner so earlier QA traffic cannot consume its limit.
    const owner="reader-http-"+randomUUID();
    const profile=(await http(kernel,"/v1/profiles",{external_owner_id:owner})).data;
    const request={external_owner_id:owner,profile_id:profile.profile_id,keyword:"Fixture concurrency",page:1,limit:20};
    await fixture("control",{search_delay:1});
    const pending=Promise.all(Array.from({length:6},()=>http(kernel,"/v1/search/videos",request,[200,409])));
    const during=await until(()=>fixture("state"),(s)=>s.readers===4,"four bounded readers");
    const responses=await pending;
    assert.equal(responses.filter(r=>r.response.status===200).length,4);
    assert.equal(responses.filter(r=>r.response.status===409).length,2);
    assert.ok(responses.filter(r=>r.response.status===409).every(r=>Number(r.response.headers.get("retry-after"))>0));
    await fixture("control",{search_delay:0});
    for (let index=0;index<4;index++) await http(kernel,"/v1/search/videos",request);
    const limited=await http(kernel,"/v1/search/videos",request,429);
    assert.ok(Number(limited.response.headers.get("retry-after"))>0);
    report.checks.push({name:"six callers: four admitted, two safely rejected; then rate limited",during});
    const retrySeconds=Number(limited.response.headers.get("retry-after"));
    console.log("Rate limiter recovery: waiting "+retrySeconds+" seconds in short intervals");
    let nextDelay=retrySeconds;
    let recovered=false;
    // Real desktop/container clocks can differ across a host suspend. Record any
    // renewed 429 and obey its new delay; retries remain bounded to three.
    for (let attempt=0;attempt<3;attempt++) {
      for (let remaining=nextDelay*1000+1000;remaining>0;remaining-=1000) await sleep(Math.min(remaining,1000));
      const retry=await http(kernel,"/v1/search/videos",request,[200,429]);
      if(retry.response.status===200){recovered=true;break;}
      nextDelay=Number(retry.response.headers.get("retry-after"));
      assert.ok(nextDelay>0&&nextDelay<=60);
      report.checks.push({name:"renewed retry delay",seconds:nextDelay});
    }
    assert.equal(recovered,true,"bounded rate-limit recovery");
    const clean=await fixture("state");
    assert.equal(clean.readers,0); assert.equal(clean.browsers,0);
    report.checks.push({name:"Retry-After recovery without leaked readers",clean});
  } else throw new Error("Use cancel, before-restart, after-restart or readers");
  report.passed=true;
} catch(error) {
  report.passed=false; report.failure=error.message; console.error(error); process.exitCode=1;
} finally {
  if(mode!=="before-restart")await fixture("control",{hold_browser:false,hold_media:false,search_delay:0}).catch(()=>{});
  report.finishedAt=new Date().toISOString();
  const file=path.join(directory,randomUUID()+"-"+mode+".json");
  await writeFile(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,mode,requests:report.requests.length,report:file}));
}
