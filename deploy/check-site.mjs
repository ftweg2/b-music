// Authenticated deployment smoke test. Passwords stay in memory/private files.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
const privateDir=path.join(import.meta.dirname,"private");
const access=JSON.parse(await fs.readFile(path.join(privateDir,"access.json"),"utf8"));
assert.equal(access.url,"https://bmusic.ftwegc.com");
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED,"0","TLS verification must stay enabled");
const authorization="Basic "+Buffer.from(access.username+":"+access.password).toString("base64");
const report={at:new Date().toISOString(),checks:[],requests:[]};
async function call(url,{method="GET",body,headers={}}={}){
  const id=randomUUID();const start=performance.now();
  const response=await fetch(new URL(url,access.url),{method,redirect:"error",headers:{authorization,"x-request-id":id,...(body===undefined?{}:{"content-type":"application/json"}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  const bytes=Buffer.from(await response.arrayBuffer());
  const json=response.headers.get("content-type")?.includes("json")?JSON.parse(bytes.toString()):undefined;
  report.requests.push({method,path:new URL(url,access.url).pathname,status:response.status,ms:Math.round(performance.now()-start)});
  return {response,bytes,json};
}
try{
  const anonymous=await fetch(access.url,{redirect:"error",signal:AbortSignal.timeout(15000)});
  assert.equal(anonymous.status,401);await anonymous.body?.cancel();
  report.checks.push("Unauthenticated access is blocked");
  const home=await call("/");assert.equal(home.response.status,200);assert.match(home.bytes.toString(),/B-Music/);
  const assets=[...home.bytes.toString().matchAll(/(?:href|src)="([^\"]*\/_next\/static\/[^\"]+)"/g)].map(m=>m[1]);
  assert.ok(assets.length);
  for(const asset of [...new Set(assets)].slice(0,3))assert.equal((await call(asset)).response.status,200);
  for(const endpoint of ["/api/health","/api/kernel/health","/api/capabilities","/api/openapi.json","/api/favorites","/api/playlists","/api/tracks"]){assert.equal((await call(endpoint)).response.status,200,endpoint);}
  report.checks.push("HTTPS HTML, static assets and authenticated API health/library reads succeed");
  const forbidden=await call("/api/playlists",{method:"POST",body:{name:"blocked-origin-check"},headers:{origin:"https://untrusted.example"}});
  assert.equal(forbidden.response.status,403);
  const invalid=await call("/api/playlists",{method:"POST",body:{name:""},headers:{origin:access.url}});
  assert.equal(invalid.response.status,400);
  report.checks.push("Correct HTTPS Origin reaches validation; foreign Origin is denied");
  const login=(await call("/api/kernel/login/status")).json;
  report.loggedIn=login.loggedIn;
  if(!login.loggedIn){
    const started=await call("/api/kernel/login/start",{method:"POST",headers:{origin:access.url,"x-account-context":login.sessionKey}});
    assert.equal(started.response.status,200,JSON.stringify(started.json));
    const qr=await call(started.json.qrImageUrl);
    assert.equal(qr.response.status,200);assert.equal(qr.bytes.subarray(1,4).toString(),"PNG");
    await fs.writeFile(path.join(privateDir,"qr-check.png"),qr.bytes,{mode:0o600});
    const pending=(await call("/api/kernel/login/status")).json;
    if(!pending.loggedIn&&pending.loginStatus==="pending"){
      const cancelled=await call("/api/kernel/login/logout",{method:"POST",body:{confirmed:true},headers:{origin:access.url,"x-account-context":pending.sessionKey}});
      assert.ok([200,409].includes(cancelled.response.status));
    }
    report.checks.push("Real VPS browser creates a QR image; test-only pending login cleaned up without logging out a verified account");
  }
  report.passed=true;
}catch(error){report.passed=false;report.failure=error.message;console.error(error.message);process.exitCode=1;}
finally{await fs.writeFile(path.join(privateDir,"site-verification.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
