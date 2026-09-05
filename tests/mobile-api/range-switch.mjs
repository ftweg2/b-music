// Switch only the guarded test server's fake identity for browser QA.
import assert from "node:assert/strict";
const uid=process.argv[2];
assert.ok(["111111","222222"].includes(uid));
const base="http://127.0.0.1:3100",fixture="http://127.0.0.1:8100/__fixture/";
async function call(url,body){const response=await fetch(url,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(40000)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
assert.equal((await call(fixture+"state")).fixture,"isolated-only");
await call(base+"/api/kernel/login/logout",{confirmed:true});
await call(fixture+"control",{uid:null});
await call(base+"/api/kernel/login/start",{});
await call(fixture+"control",{uid});
let status;
for(let index=0;index<40;index++){status=await call(base+"/api/kernel/login/status");if(status.loggedIn&&status.biliUid===uid)break;await new Promise(resolve=>setTimeout(resolve,200));}
assert.equal(status.biliUid,uid);assert.equal(status.appOwnerId,"bili:"+uid);
console.log(JSON.stringify({accountId:status.appOwnerId,range:(await call(base+"/api/playback-ranges/BV1test00001")).playbackRange}));
