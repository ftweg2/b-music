// Anonymous HTTPS smoke test. Read-only unless an explicit check flag is supplied.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
const privateDir=path.join(import.meta.dirname,"private");
const siteUrl="https://bmusic.ftwegc.com";
const args=new Set(process.argv.slice(2));
for(const arg of args)assert.ok(["--check-origin","--check-login"].includes(arg),"Unknown argument: "+arg);
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED,"0","TLS verification must stay enabled");
await fs.mkdir(privateDir,{recursive:true});
const report={at:new Date().toISOString(),readOnly:args.size===0,checks:[],requests:[]};
async function call(url,{method="GET",body,headers={}}={}){
  const id=randomUUID();const start=performance.now();
  const target=new URL(url,siteUrl);
  assert.equal(target.origin,siteUrl,"Only same-origin HTTPS requests are allowed");
  const response=await fetch(target,{method,redirect:"error",headers:{"x-request-id":id,...(body===undefined?{}:{"content-type":"application/json"}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  const bytes=Buffer.from(await response.arrayBuffer());
  const json=response.headers.get("content-type")?.includes("json")?JSON.parse(bytes.toString()):undefined;
  report.requests.push({method,path:target.pathname,status:response.status,ms:Math.round(performance.now()-start)});
  assert.equal(response.headers.get("www-authenticate"),null,"Unexpected gateway login challenge at "+target.pathname);
  return {response,bytes,json};
}
try{
  const home=await call("/");assert.equal(home.response.status,200);assert.match(home.bytes.toString(),/B-Music/);
  report.checks.push("Anonymous access succeeds without a gateway login challenge");
  const assets=[...home.bytes.toString().matchAll(/(?:href|src)="([^\"]*\/_next\/static\/[^\"]+)"/g)].map(m=>m[1]);
  assert.ok(assets.length);
  for(const asset of [...new Set(assets)].slice(0,3))assert.equal((await call(asset)).response.status,200);
  for(const endpoint of ["/api/health","/api/kernel/health","/api/capabilities","/api/openapi.json","/api/favorites","/api/playlists","/api/tracks"]){assert.equal((await call(endpoint)).response.status,200,endpoint);}
  report.checks.push("HTTPS HTML, static assets and anonymous API health/library reads succeed");
  if(args.has("--check-origin")){
    const forbidden=await call("/api/playlists",{method:"POST",body:{name:""},headers:{origin:"https://untrusted.example"}});
    assert.equal(forbidden.response.status,403);
    const invalid=await call("/api/playlists",{method:"POST",body:{name:""},headers:{origin:siteUrl}});
    assert.equal(invalid.response.status,400);
    report.checks.push("Correct HTTPS Origin reaches validation; foreign Origin is denied");
  }
  const loginResult=await call("/api/kernel/login/status");
  assert.equal(loginResult.response.status,200);
  const login=loginResult.json;
  report.loggedIn=login.loggedIn;
  report.checks.push("Bilibili login status remains accessible");
  if(args.has("--check-login")){
    assert.equal(login.loggedIn,false,"QR check requires a logged-out test service");
    assert.notEqual(login.loginStatus,"pending","Do not interrupt an existing QR login");
    const started=await call("/api/kernel/login/start",{method:"POST",headers:{origin:siteUrl,"x-account-context":login.sessionKey}});
    assert.equal(started.response.status,200,JSON.stringify(started.json));
    const qr=await call(started.json.qrImageUrl);
    assert.equal(qr.response.status,200);assert.equal(qr.bytes.subarray(1,4).toString(),"PNG");
    await fs.writeFile(path.join(privateDir,"qr-check.png"),qr.bytes,{mode:0o600});
    const pending=(await call("/api/kernel/login/status")).json;
    if(!pending.loggedIn&&pending.loginStatus==="pending"){
      const cancelled=await call("/api/kernel/login/logout",{method:"POST",body:{confirmed:true},headers:{origin:siteUrl,"x-account-context":pending.sessionKey}});
      assert.ok([200,409].includes(cancelled.response.status));
    }
    report.checks.push("Real VPS browser creates a QR image; test-only pending login cleaned up without logging out a verified account");
  }
  report.passed=true;
}catch(error){report.passed=false;report.failure=error.message;console.error(error.message);process.exitCode=1;}
finally{
  const reportPath=path.join(privateDir,"site-verification-"+report.at.replace(/[:.]/g,"-")+".json");
  await fs.writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600,flag:"wx"});
  console.log(JSON.stringify(report));
  console.log("Report saved to "+reportPath);
}
