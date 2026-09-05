// A native HTTP client: no imports from App/kernel, no access to either database.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "http://127.0.0.1:3100";
const FIXTURE = "http://127.0.0.1:8100";
const runId = randomUUID();
const report = {runId, startedAt:new Date().toISOString(), scope:"Isolated production Next + real kernel, Chrome and ffmpeg; deterministic Bilibili upstream", rounds:20, requests:[], checks:[], failures:[], coverage:{}};
let document;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve,ms));

function validate(value, schema, at = "response") {
  if (!schema || schema === true) return;
  if (schema.$ref) return validate(value, schema.$ref.split("/").slice(1).reduce((node,key) => node[key],document),at);
  for (const item of schema.allOf || []) validate(value,item,at);
  if (schema.anyOf) assert.ok(schema.anyOf.some((item) => {try {validate(value,item,at);return true;}catch{return false;}}),at+" anyOf");
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    assert.ok(types.includes(actual) || (types.includes("integer") && Number.isSafeInteger(value)),`${at}: expected ${types}, received ${actual}`);
    if (value === null) return;
  }
  if (schema.const !== undefined) assert.deepEqual(value,schema.const,at);
  if (schema.enum) assert.ok(schema.enum.includes(value),at+" enum");
  if (typeof value === "number") {
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum,at+" minimum");
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum,at+" maximum");
  }
  if (typeof value === "string") {
    if (schema.pattern) assert.match(value,new RegExp(schema.pattern),at);
    if (schema.minLength) assert.ok(value.length >= schema.minLength,at);
    if (schema.maxLength) assert.ok(value.length <= schema.maxLength,at);
    if (schema.format === "date-time") assert.ok(Number.isFinite(Date.parse(value)),at+" date-time");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems,at+" minItems");
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems,at+" maxItems");
    if (schema.uniqueItems) assert.equal(new Set(value.map((item) => JSON.stringify(item))).size,value.length,at);
    value.forEach((item,index) => validate(item,schema.items,at+"["+index+"]"));
  } else if (value && typeof value === "object") {
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value,key),at+" missing "+key);
    for (const [key,item] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (child) validate(item,child,at+"."+key);
      else if (typeof schema.additionalProperties === "object") validate(item,schema.additionalProperties,at+"."+key);
    }
  }
}
function operation(method, url) {
  const pathname = new URL(url,BASE).pathname;
  const template = document?.paths[pathname] ? pathname : Object.keys(document?.paths || {}).find((item) => new RegExp("^" + item.replace(/[.]/g,"\\.").replace(/\{[^}]+\}/g,"[^/]+") + "$").test(pathname));
  return template && document.paths[template][method.toLowerCase()] ? {key:method+" "+template, value:document.paths[template][method.toLowerCase()]} : null;
}
async function request(method, url, body, options = {}) {
  const id = runId.slice(0,8)+"-"+report.requests.length+"-"+randomUUID().slice(0,8);
  const started = performance.now();
  const entry = {method,url,requestId:id};
  report.requests.push(entry);
  try {
    const response = await fetch(new URL(url,BASE), {method, headers:{"x-request-id":id,...(body === undefined ? {} : {"content-type":"application/json"}), ...options.headers}, body:options.raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal:AbortSignal.timeout(45000)});
    const bytes = Buffer.from(await response.arrayBuffer());
    const data = bytes.length && response.headers.get("content-type")?.includes("json") ? JSON.parse(bytes.toString()) : undefined;
    Object.assign(entry,{status:response.status,ms:Math.round(performance.now()-started),bytes:bytes.length});
    const expected = options.status ?? 200;
    assert.ok((Array.isArray(expected)?expected:[expected]).includes(response.status),`${method} ${url}: ${response.status} ${JSON.stringify(data)}`);
    assert.equal(response.headers.get("x-request-id"),id,"request tracing");
    assert.equal(response.headers.get("x-api-revision"),"1.2.0");
    const op = operation(method,url);
    if (op) {
      const contract = op.value.responses[response.status];
      assert.ok(contract,op.key+" undocumented status "+response.status);
      if (data !== undefined) {
        const schema = contract.content?.["application/json"]?.schema;
        assert.ok(schema,op.key+" missing JSON schema");
        validate(data,schema);
      } else if (method !== "HEAD" && ![204,304].includes(response.status)) {
        assert.ok(Object.keys(contract.content || {}).some((type) => type !== "application/json"),op.key+" expected JSON");
      }
      const coverage = report.coverage[op.key] ??= {success:0,error:0};
      coverage[response.ok || response.status === 304 ? "success" : "error"]++;
    }
    if (response.status >= 400 && method !== "HEAD") {
      validate(data,document.components.schemas.ApiError);
      assert.equal(data.requestId,id);
    }
    return {data,bytes,response};
  } catch (error) { entry.failure=error.message; throw error; }
}
const get = async (url,options) => (await request("GET",url,undefined,options)).data;
const post = async (url,body,options) => (await request("POST",url,body,options)).data;
async function fixture(url,body) {
  const response = await fetch(FIXTURE+"/__fixture/"+url,{method:body === undefined ? "GET" : "POST",headers:{"content-type":"application/json"},body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200,"fixture "+url);
  return response.json();
}
async function until(action,predicate,label,timeout=30000) {
  const deadline=Date.now()+timeout;
  let result;
  do {result=await action();if(predicate(result))return result;await delay(200);} while(Date.now()<deadline);
  throw new Error("Timed out: "+label+" "+JSON.stringify(result));
}
async function check(name,fn) {
  const start=performance.now();
  await fn();
  report.checks.push({name,ms:Math.round(performance.now()-start),passed:true});
  console.log("ok - "+name);
}
const ids = (page) => page.candidates.map((candidate) => candidate.bvid);
let first, second, following, persistent, ready, signedSearch;
try {
  await until(()=>fixture("state").catch(()=>null),(state)=>state?.fixture==="isolated-only","isolated kernel startup");
  document=await get("/api/openapi.json");
  await check("health, capabilities, diagnostics and CORS for every registered path",async () => {
    for (const url of ["/api/health","/api/capabilities","/api/diagnostics","/api/kernel/health"]) await get(url);
    for (const template of Object.keys(document.paths)) {
      const url=template.replace(/\{[^}]+\}/g,"1");
      const result=await request("OPTIONS",url,undefined,{status:204,headers:{origin:"capacitor://localhost","access-control-request-method":"POST"}});
      assert.equal(result.response.headers.get("access-control-allow-origin"),"capacitor://localhost");
    }
    await request("OPTIONS","/api/playlists",undefined,{status:403,headers:{origin:"https://untrusted.example"}});
    await post("/api/playlists",{name:"blocked"},{status:403,headers:{origin:"https://untrusted.example"}});
    // Invalid name cannot write, but must reach validation from our own page.
    await post("/api/playlists",{name:""},{status:400,headers:{origin:BASE}});
  });
  await check("strict bodies, IDs, pagination and strategy validation",async () => {
    for (const raw of ["{","[]","null","42"]) await request("POST","/api/playlists",undefined,{status:400,raw});
    await post("/api/playlists",{name:"x".repeat(66000)},{status:413});
    await request("POST","/api/playlists",undefined,{status:415,raw:"name=test",headers:{"content-type":"application/x-www-form-urlencoded"}});
    for (const url of ["/api/candidates?limit=-1","/api/candidates?offset=1.5","/api/favorites?limit=101","/api/tracks?limit=0","/api/candidates/nope","/api/playlists/0","/api/tracks/false"]) await get(url,{status:400});
    await post("/api/search",{keyword:" ",page:1},{status:400});
    await post("/api/search",{keyword:"music",page:11},{status:400});
    await post("/api/tracks/prepare",{candidateId:true},{status:400});
    await post("/api/tracks/prepare",{candidateId:1,strategyMode:"force"},{status:400});
    await post("/api/tracks/status",{trackIds:[1,true]},{status:400});
    await post("/api/tracks/status",{trackIds:Array.from({length:21},(_,index)=>index+1)},{status:413});
    for (const url of ["/api/candidates/99999999","/api/playlists/99999999","/api/tracks/99999999"]) await get(url,{status:404});
  });
  await check("public search, followed-UP priority and fixed page membership",async () => {
    following=(await post("/api/creators",{biliMid:"4242",name:"Fixture followed UP"},{status:201})).creator;
    first=await post("/api/search",{keyword:"Fixture Music",provider:"bilibili",useRemote:true});
    assert.equal(first.candidates.length,20);
    assert.equal(first.candidates[0].isPreferredCreator,true);
    const again=await post("/api/search",{keyword:"Fixture Music",provider:first.provider,useRemote:true,searchId:first.searchId,page:1,limit:first.limit});
    assert.deepEqual(ids(again),ids(first));
    second=await post("/api/search",{keyword:"Fixture Music",provider:first.provider,useRemote:true,searchId:first.searchId,page:2,limit:first.limit});
    assert.equal(second.candidates.length,19);
    assert.equal(second.duplicatesRemoved,1);
    assert.ok(!ids(second).some((id)=>ids(first).includes(id)));
  });
  await check("20 serial CRUD rounds and concurrent idempotent writes",async () => {
    for (let round=1;round<=20;round++) {
      const a=first.candidates[0], b=first.candidates[1];
      const key=runId+"-playlist-"+round;
      const bodies=await Promise.all(Array.from({length:5},()=>post("/api/playlists",{name:"HTTP round "+round,candidateId:a.id},{status:201,headers:{"idempotency-key":key}})));
      assert.equal(new Set(bodies.map((item)=>item.playlist.id)).size,1);
      const playlist=bodies[0].playlist;
      const base="/api/playlists/"+playlist.id;
      await post("/api/playlists",{name:"conflict"},{status:409,headers:{"idempotency-key":key}});
      await request("PATCH",base,{name:"Edited "+round,description:"Mobile integration"});
      await Promise.all(Array.from({length:5},()=>post(base+"/items",{candidateId:b.id})));
      const detail=(await get(base)).playlist;
      assert.equal(detail.items.length,2);
      const order=detail.items.map((item)=>item.id).reverse();
      await request("PATCH",base+"/items",{itemIds:order});
      assert.deepEqual((await get(base)).playlist.items.map((item)=>item.id),order);
      await request("PATCH",base+"/items",{itemIds:[order[0]]},{status:409});
      await post("/api/favorites",{candidateId:a.id,note:"Keep note"},{status:201});
      await post("/api/favorites",{candidateId:b.id},{status:201});
      await Promise.all(Array.from({length:4},()=>post("/api/favorites",{candidateId:a.id},{status:201})));
      const favorites=await get("/api/favorites");
      assert.ok(favorites.items.length>=2);
      assert.equal(favorites.items.find((item)=>item.favorite.bvid===a.bvid).favorite.note,"Keep note");
      assert.equal(favorites.items.find((item)=>item.favorite.bvid===a.bvid).candidate.isPreferredCreator,true);
      await get("/api/favorites?limit=1&offset=1");
      const events=await Promise.all(Array.from({length:5},()=>post("/api/candidates/"+a.id,{action:"viewed"},{status:201,headers:{"idempotency-key":runId+"-event-"+round}})));
      assert.equal(new Set(events.map((item)=>item.interaction.id)).size,1);
      await get("/api/candidates/"+a.id);
      await get("/api/candidates");
      await get("/api/recommendations");
      await get("/api/playlists");
      const creator=(await post("/api/creators",{biliMid:"98765",name:"Round UP"},{status:201})).creator;
      const duplicate=(await post("/api/creators",{biliMid:"98765",name:"Round UP"},{status:201})).creator;
      assert.equal(creator.id,duplicate.id);
      await request("PATCH","/api/creators/"+creator.id,{name:"Renamed",notes:null});
      await request("PATCH","/api/creators/"+creator.id,{name:{bad:true}},{status:400});
      await request("PATCH","/api/creators/"+creator.id,{homepageUrl:"https://space.bilibili.com/123"},{status:400});
      await get("/api/creators");
      await request("DELETE","/api/creators/"+creator.id);
      await request("DELETE","/api/creators/"+creator.id,undefined,{status:404});
      await request("DELETE",base+"/items/"+order[0]);
      await request("DELETE",base+"/items/"+order[0],undefined,{status:[200,404]});
      await request("DELETE",base);
      await request("DELETE",base,undefined,{status:404});
      await request("DELETE","/api/favorites/"+a.id);
      await request("DELETE","/api/favorites/"+b.id);
      await request("DELETE","/api/favorites/"+a.id,undefined,{status:[200,404]});
    }
    persistent=(await post("/api/playlists",{name:"Survives account switching",candidateId:first.candidates[0].id},{status:201})).playlist;
    await post("/api/favorites",{candidateId:first.candidates[0].id},{status:201});
  });
  await check("real browser QR: retries, expiry, cancel and two account identities",async () => {
    await post("/api/kernel/login/logout",{confirmed:false},{status:400});
    await post("/api/kernel/login/logout",{confirmed:true},{headers:{origin:"capacitor://localhost"}});
    for (let cycle=0;cycle<3;cycle++) {
      await fixture("control",{uid:null});
      const started=await post("/api/kernel/login/start");
      for (let retry=0;retry<3;retry++) assert.equal((await post("/api/kernel/login/start")).loginSessionId,started.loginSessionId);
      const qr=await request("GET",started.qrImageUrl);
      assert.equal(qr.bytes.subarray(1,4).toString(),"PNG");
      const forged=new URL(started.qrImageUrl,BASE); forged.searchParams.set("profileId","p_0000000000000000");
      await get(forged.pathname+forged.search,{status:404});
      if (cycle===0) {
        await fixture("expire-login",{});
        await until(()=>fixture("state"),(s)=>s.login_watchers===0,"QR expiry");
        await get(started.qrImageUrl,{status:404});
      } else if (cycle===1) {
        await post("/api/kernel/login/logout",{confirmed:true});
        await get(started.qrImageUrl,{status:404});
      } else {
        await fixture("control",{uid:"111111"});
        await until(()=>get("/api/kernel/login/status"),(s)=>s.loggedIn,"first login");
        await until(()=>fixture("state"),(s)=>s.login_watchers===0,"login cleanup");
      }
    }
    const before=await get("/api/kernel/login/status");
    signedSearch=await post("/api/search",{keyword:"Fixture Auth",useRemote:true,provider:"auto"});
    await post("/api/kernel/login/logout",{confirmed:true});
    await fixture("control",{uid:null});
    await post("/api/kernel/login/start");
    await fixture("control",{uid:"222222"});
    const after=await until(()=>get("/api/kernel/login/status"),(s)=>s.loggedIn&&s.biliUid==="222222","second login");
    await until(()=>fixture("state"),(s)=>s.login_watchers===0,"second login cleanup");
    assert.notEqual(before.sessionKey,after.sessionKey);
    await post("/api/search",{keyword:"Fixture Auth",useRemote:true,provider:"kernel",page:2,searchId:signedSearch.searchId,sessionKey:signedSearch.sessionKey},{status:409});
    assert.equal((await get("/api/playlists/"+persistent.id)).playlist.id,persistent.id);
    assert.equal((await get("/api/favorites")).items.length,1);
  });
  await check("new search pages while real audio capture and ffmpeg are still active",async () => {
    await fixture("control",{hold_browser:true,hold_media:true});
    signedSearch=await post("/api/search",{keyword:"Fixture Parallel",useRemote:true,provider:"kernel"});
    const payload={candidateId:first.candidates[0].id,strategyMode:"force",strategy:"browser_network"};
    const prepared=await Promise.all(Array.from({length:8},()=>post("/api/tracks/prepare",payload)));
    assert.equal(new Set(prepared.map((item)=>item.track.kernelJobId)).size,1);
    const track=prepared[0].track;
    const active=await until(()=>fixture("state"),(s)=>s.browser_stage,"browser capture stage");
    assert.equal(active.browsers,1); assert.equal(active.browser_leases,1);
    await request("GET","/api/tracks/"+track.id+"/stream",undefined,{status:409});
    const pagePayload={keyword:"Fixture Parallel",useRemote:true,provider:"kernel",sessionKey:signedSearch.sessionKey,searchId:signedSearch.searchId,limit:signedSearch.limit};
    const pages=await Promise.all(Array.from({length:5},()=>post("/api/search",{...pagePayload,page:2})));
    assert.equal(new Set(pages.map((p)=>JSON.stringify(ids(p)))).size,1);
    const jumped=await post("/api/search",{...pagePayload,page:5});
    assert.equal(jumped.page,5);
    const during=await fixture("state");
    assert.equal(during.browser_stage,true); assert.equal(during.launches,active.launches);
    assert.equal(during.readers,0); assert.equal(during.browsers,1);
    await post("/api/kernel/login/logout",{confirmed:true},{status:409});
    await fixture("control",{hold_browser:false});
    await until(()=>fixture("state"),(s)=>s.media_stage,"media processing stage");
    await post("/api/search",{...pagePayload,page:3});
    assert.equal((await fixture("state")).media_stage,true);
    await fixture("control",{hold_media:false});
    ready=(await until(()=>get("/api/tracks/"+track.id),(data)=>data.track.status!=="preparing","ready audio")).track;
    assert.equal(ready.status,"ready",ready.failureReason);
    report.parallelEvidence={jobId:ready.kernelJobId,pages:[2,5,3],captureLaunchesBefore:active.launches,captureLaunchesAfter:during.launches,trackStatus:ready.status};
  });
  await check("20 native playback/download rounds: HEAD, Range, validators and checksum",async () => {
    for (let round=0;round<20;round++) {
      const track=(await post("/api/tracks/prepare",{candidateId:ready.candidateId})).track;
      assert.equal(track.kernelJobId,ready.kernelJobId);
      await get("/api/tracks");
      await get("/api/tracks?limit=1&offset=0&status=ready");
      const batch=await post("/api/tracks/status",{trackIds:[ready.id,ready.id,99999999]});
      assert.equal(batch.tracks.length,1); assert.deepEqual(batch.missingTrackIds,[99999999]);
      for (const kind of ["stream","download"]) {
        const url="/api/tracks/"+ready.id+"/"+kind;
        const head=await request("HEAD",url);
        assert.equal(head.bytes.length,0);
        const full=await request("GET",url);
        const checksum=createHash("sha256").update(full.bytes).digest("hex");
        assert.equal(checksum,ready.media.checksum.value);
        assert.equal(full.bytes.length,ready.media.sizeBytes);
        const etag=head.response.headers.get("etag");
        const firstPart=await request("GET",url,undefined,{status:206,headers:{range:"bytes=0-99","if-range":etag}});
        const remainder=await request("GET",url,undefined,{status:206,headers:{range:"bytes=100-","if-range":etag}});
        assert.deepEqual(Buffer.concat([firstPart.bytes,remainder.bytes]),full.bytes);
        const cached=await request("GET",url,undefined,{status:304,headers:{"if-none-match":etag}});
        assert.equal(cached.bytes.length,0);
        const changed=await request("GET",url,undefined,{headers:{range:"bytes=0-99","if-range":"\"old\""}});
        assert.deepEqual(changed.bytes,full.bytes);
        const invalid=await request("GET",url,undefined,{status:416,headers:{range:"bytes=999999999-"}});
        assert.equal(invalid.response.headers.get("content-range"),"bytes */"+full.bytes.length);
      }
    }
  });
  await check("search failure and retry retain snapshot and never substitute cached music",async () => {
    const payload={keyword:"Fixture Parallel",useRemote:true,provider:"kernel",sessionKey:signedSearch.sessionKey,searchId:signedSearch.searchId,limit:signedSearch.limit,page:4};
    await fixture("control",{search_error_page:4});
    const error=await post("/api/search",payload,{status:502});
    assert.equal(error.searchId,signedSearch.searchId);
    assert.equal(error.candidates,undefined);
    await fixture("control",{search_error_page:0});
    const recovered=await post("/api/search",payload);
    assert.equal(recovered.page,4);
    const seen=(await fixture("state")).search_requests.filter((item)=>item.keyword==="Fixture Parallel");
    assert.deepEqual(seen.map((item)=>item.page),[1,2,5,3,4,4]);
  });
  await check("refresh, expiration and failed media recover without stale locks",async () => {
    const url="/api/tracks/"+ready.id;
    await fixture("expire-artifact/"+ready.kernelJobId,{});
    await request("GET",url+"/stream",undefined,{status:410});
    await fixture("control",{fail_media:true});
    await post(url+"/refresh",{strategyMode:"force",strategy:"browser_network"});
    const failed=(await until(()=>get(url),(data)=>data.track.status==="failed","failed audio")).track;
    assert.equal(failed.status,"failed");
    await fixture("control",{fail_media:false});
    await post(url+"/refresh",{strategyMode:"force",strategy:"browser_network"});
    ready=(await until(()=>get(url),(data)=>data.track.status!=="preparing","recovered audio")).track;
    assert.equal(ready.status,"ready",ready.failureReason);
    await request("GET",url+"/download");
    const clean=await until(()=>fixture("state"),(s)=>!s.active_jobs&&!s.readers&&!s.locks&&!s.browsers,"resources released");
    report.finalRuntime=clean;
  });
  await check("cover images reject SVG, redirects and untrusted hosts",async () => {
    for (let repeat=0;repeat<3;repeat++) {
      await request("GET","/api/image-proxy?url="+encodeURIComponent("https://i0.hdslb.com/bfs/fixture.png"));
      await get("/api/image-proxy?url="+encodeURIComponent("https://i0.hdslb.com/bfs/unsafe.svg"),{status:415});
      await get("/api/image-proxy?url="+encodeURIComponent("https://i0.hdslb.com/bfs/redirect.png"),{status:[400,502]});
      await get("/api/image-proxy?url="+encodeURIComponent("http://127.0.0.1/private"),{status:400});
    }
  });
  await check("all registered mobile operations have successful HTTP/schema evidence",async () => {
    const resource="/api/playback-ranges/"+first.candidates[0].bvid;
    const initial=(await get(resource)).playbackRange;
    const updated=(await request("PATCH",resource,{startSeconds:0.5,endSeconds:1.5,expectedRevision:initial.revision,expectedAccountId:initial.accountId})).data.playbackRange;
    await request("PATCH",resource,{startSeconds:0,endSeconds:null,expectedRevision:updated.revision,expectedAccountId:updated.accountId});
    const missing=[];
    for (const [url,methods] of Object.entries(document.paths)) for (const method of Object.keys(methods)) {
      const key=method.toUpperCase()+" "+url;
      if (!report.coverage[key]?.success) missing.push(key);
    }
    assert.deepEqual(missing,[]);
  });
} catch (error) {
  report.failures.push({message:error.message,stack:error.stack});
  console.error(error);
  process.exitCode=1;
} finally {
  // This server is explicitly isolated; never clear the user's real library.
  await fixture("control",{hold_browser:false,hold_media:false,fail_media:false,search_error_page:0}).catch(()=>{});
  report.finishedAt=new Date().toISOString();
  report.passed=report.failures.length===0;
  const directory=path.resolve(import.meta.dirname,"reports");
  await mkdir(directory,{recursive:true});
  const file=path.join(directory,runId+".json");
  await writeFile(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,requests:report.requests.length,operations:Object.keys(report.coverage).length,report:file}));
}
