/** Repeatable metadata-only benchmark. Never opens the user's library. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getDatabase, listTracks, closeDatabaseForTests } from "../lib/db";
import * as trackApi from "../lib/trackApi";
import type { Track } from "../lib/models";

const label=process.argv[2]||"measurement";
if(!/^[a-z0-9-]+$/.test(label))throw new Error("Invalid benchmark label");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"b-music-perf-"));
process.env.DATABASE_PATH=path.join(directory,"metadata.sqlite");
const db=getDatabase();
const candidate=db.prepare("INSERT INTO candidate_videos(id,bvid,title,source_url,source_provider,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
const track=db.prepare("INSERT INTO tracks(id,external_owner_id,kernel_owner_id,candidate_id,bvid,title,source_url,kernel_job_id,artifact_name,duration_seconds,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
const range=db.prepare("INSERT INTO playback_ranges(owner_id,bvid,start_seconds,end_seconds,revision,updated_at) VALUES(?,?,?,?,?,?)");
db.exec("BEGIN");
for(let i=1;i<=20000;i++){
  const bvid="BV"+String(i).padStart(10,"0");
  const stamp=new Date(Date.UTC(2026,0,1)+(i%1000)*1000).toISOString();
  const url="https://www.bilibili.com/video/"+bvid;
  candidate.run(i,bvid,"Performance "+i,url,"benchmark",stamp,stamp,stamp);
  track.run(i,"perf","perf",i,bvid,"Performance "+i,url,"perf_"+i,"audio.m4a",200,i%5?"ready":"failed",stamp,stamp);
  if(i%2)range.run("perf",bvid,10,180,1,stamp);
}
db.exec("COMMIT");
function measure(action:()=>unknown,rounds:number){
  for(let i=0;i<25;i++)action();
  const samples=[];
  for(let i=0;i<rounds;i++){const start=performance.now();action();samples.push(performance.now()-start);}
  samples.sort((a,b)=>a-b);
  return {rounds,medianMs:samples[Math.floor(rounds/2)],p95Ms:samples[Math.floor(rounds*.95)]};
}
const rows=listTracks(100,"perf");
const optimized=(trackApi as unknown as {toTrackApiResources?:(rows:Track[])=>trackApi.TrackApiResource[]}).toTrackApiResources;
const serialize=()=>optimized?optimized(rows):rows.map(trackApi.toTrackApiResource);
const result={label,node:process.version,rows:20000,page:measure(()=>listTracks(51,"perf",0,"ready"),500),serialize100:measure(serialize,500),
  responseSha256:createHash("sha256").update(JSON.stringify(serialize())).digest("hex"),
  queryPlan:db.prepare("EXPLAIN QUERY PLAN SELECT * FROM tracks WHERE external_owner_id=? AND status=? ORDER BY updated_at DESC,id DESC LIMIT 51").all("perf","ready").map(row=>row.detail)};
const reports=path.resolve("../tests/performance-reports");fs.mkdirSync(reports,{recursive:true});
fs.writeFileSync(path.join(reports,label+".json"),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));closeDatabaseForTests();
