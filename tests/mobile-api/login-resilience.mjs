// Destructive login controls are allowed only on the explicitly guarded fixture.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
const base="http://127.0.0.1:3100", kernel="http://127.0.0.1:8100";
const report={at:new Date().toISOString(),checks:[],requests:[]};
async function request(url,method="GET",body,status=200,context){
  const start=performance.now();
  const response=await fetch(url,{method,headers:{...(body===undefined?{}:{"content-type":"application/json"}),...(context?{"x-account-context":context}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const bytes=Buffer.from(await response.arrayBuffer());
  const data=response.headers.get("content-type")?.includes("json")?JSON.parse(bytes):undefined;
  report.requests.push({path:new URL(url).pathname,method,status:response.status,ms:Math.round(performance.now()-start)});
  assert.equal(response.status,status,JSON.stringify(data));
  return {data,bytes,response};
}
const fixture=async(path,body)=>(await request(kernel+"/__fixture/"+path,body===undefined?"GET":"POST",body)).data;
const status=async()=>(await request(base+"/api/kernel/login/status")).data;
const mutation=async(path,body={},code=200,context)=>(await request(base+"/api/kernel/login/"+path,"POST",body,code,context??(await status()).sessionKey));
async function until(check,message){for(let attempt=0;attempt<80;attempt++){if(await check())return;await new Promise(r=>setTimeout(r,250));}throw new Error(message);}
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
assert.equal((await fixture("state")).fixture,"isolated-only","Never run against user storage or the live website");
try{
  await mutation("logout",{confirmed:true});
  const initialRuntime=await fixture("state");
  await fixture("control",{uid:null,login_generate_error:503});
  let result=await mutation("start",{},502);
  assert.equal(result.data.code,"LOGIN_UPSTREAM_UNAVAILABLE");assert.equal(result.data.retryable,true);
  assert.ok(result.response.headers.get("retry-after"));
  assert.equal((await fixture("state")).locks,0);
  await fixture("control",{login_generate_error:403});
  result=await mutation("start",{},503);
  assert.equal(result.data.code,"LOGIN_UPSTREAM_RESTRICTED");assert.equal(result.data.retryable,false);
  await fixture("control",{login_generate_error:0,login_generate_delay:11});
  result=await mutation("start",{},504);
  assert.equal(result.data.code,"LOGIN_UPSTREAM_TIMEOUT");assert.equal(result.data.retryable,true);
  assert.equal((await fixture("state")).locks,0);
  report.checks.push("Upstream timeout, outage and restriction have typed errors, not HTTP 500; preparation locks are released");
  await fixture("control",{login_generate_delay:0,login_poll_errors:2});
  const before=await fixture("state"), account=await status();
  const starts=await Promise.all(Array.from({length:6},()=>mutation("start",{},200,account.sessionKey)));
  assert.equal(new Set(starts.map(r=>r.data.loginSessionId)).size,1);
  const qrUrl=starts[0].data.qrImageUrl;
  const qr=await request(base+qrUrl);
  assert.equal(qr.bytes.subarray(1,4).toString(),"PNG");
  await until(async()=>(await fixture("state")).login_polls>=before.login_polls+3,"poll did not resume");
  assert.equal(hash((await request(base+qrUrl+"&reload=1")).bytes),hash(qr.bytes));
  assert.equal((await fixture("state")).login_generates,before.login_generates+1);
  assert.equal((await status()).loginStatus,"pending");
  report.checks.push("Six concurrent starts share one QR; transient polling failures and image reload preserve the same image");
  await fixture("control",{uid:"777777"});
  await until(async()=>(await status()).loggedIn,"confirmed identity not published");
  await until(async()=>(await fixture("state")).login_watchers===0,"login resources not closed");
  await request(base+qrUrl,"GET",undefined,404);
  await mutation("start",{},409);
  await mutation("logout",{confirmed:true});
  await fixture("control",{uid:null});
  const next=await mutation("start");
  assert.notEqual(next.data.loginSessionId,starts[0].data.loginSessionId);
  await fixture("expire-login",{});
  await until(async()=>(await fixture("state")).login_watchers===0,"expired QR retained");
  await request(base+next.data.qrImageUrl,"GET",undefined,404);
  const cancelled=await mutation("start");
  await mutation("logout",{confirmed:true});
  await request(base+cancelled.data.qrImageUrl,"GET",undefined,404);
  const clean=await fixture("state");
  assert.equal(clean.locks,0);assert.equal(clean.browser_leases,0);assert.equal(clean.browsers,0);
  assert.equal(clean.http_leases,0);assert.equal(clean.http_contexts,0);
  assert.equal(clean.launches,initialRuntime.launches,"HTTP-only QR flow must not launch Chrome");
  report.checks.push("Confirmed identity, already-logged-in guard, expiry, cancel and retry succeed without Chrome or leaked HTTP resources/locks");
  report.passed=true;
}catch(error){report.passed=false;report.failure=error.message;process.exitCode=1;}
finally{
  const dir=path.join(import.meta.dirname,"reports");await fs.mkdir(dir,{recursive:true});
  const file=path.join(dir,"login-resilience-"+report.at.replace(/[:.]/g,"-")+".json");
  await fs.writeFile(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,checks:report.checks,requests:report.requests.length,failure:report.failure,report:file}));
}
