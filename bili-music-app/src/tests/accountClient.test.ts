import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_STATUS_EVENT, accountFetch, publishClientAccount, type ClientAccount } from "../lib/accountClient";

test("unchanged account polls do not notify UI, while nickname and login changes still do",()=>{
  const original=globalThis.window;
  const surface=new EventTarget() as unknown as typeof globalThis.window;globalThis.window=surface;
  let changes=0;surface.addEventListener(ACCOUNT_STATUS_EVENT,()=>changes++);
  const account:ClientAccount={appOwnerId:"bili:555",sessionKey:"perf-555",libraryMode:"account",loggedIn:true,nickname:"first"};
  try {
    publishClientAccount(account);publishClientAccount({...account});assert.equal(changes,1);
    publishClientAccount({...account,nickname:"renamed"});assert.equal(changes,2);
    publishClientAccount({...account,sessionKey:"new-session"});assert.equal(changes,3);
  } finally{globalThis.window=original;}
});

test("late old-account results are ignored, but the successful logout acknowledgement is retained",async()=>{
  const originalFetch=globalThis.fetch;
  const originalWindow=globalThis.window;
  const surface=new EventTarget() as unknown as typeof globalThis.window;
  globalThis.window=surface;
  const account=(id:string):ClientAccount=>({appOwnerId:"bili:"+id,sessionKey:"session-"+id,libraryMode:"account",loggedIn:true});
  try {
    publishClientAccount(account("111"));
    let resolve!: (response:Response)=>void;
    globalThis.fetch=()=>new Promise<Response>(done=>{resolve=done;});
    const pending=accountFetch("/api/creators");
    await Promise.resolve();
    publishClientAccount(account("222"));
    resolve(Response.json({creators:[]}));
    await assert.rejects(pending,/忽略旧账号/);
    publishClientAccount(account("111"));
    const logout=accountFetch("/api/kernel/login/logout",{method:"POST"});
    await Promise.resolve();
    publishClientAccount({...account("guest"),appOwnerId:"guest:local",loggedIn:false});
    resolve(Response.json({loggedIn:false}));
    assert.equal((await logout).status,200);
  } finally {globalThis.fetch=originalFetch;globalThis.window=originalWindow;}
});
