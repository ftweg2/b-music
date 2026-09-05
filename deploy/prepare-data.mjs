// Consistent database snapshots; copy audio cache, never browser profiles/cookies.
import fs from "node:fs/promises";
import path from "node:path";
import {DatabaseSync,backup} from "node:sqlite";
import {spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
const root=path.resolve(import.meta.dirname,"..");
const data=path.join(import.meta.dirname,"private","seed-data-"+randomUUID());
await fs.mkdir(path.join(data,"app"),{recursive:true});await fs.mkdir(path.join(data,"kernel"),{recursive:true});
const app=new DatabaseSync(path.join(root,"bili-music-app/data/bili-music-app.sqlite"),{readOnly:true});
await backup(app,path.join(data,"app/bili-music-app.sqlite"));app.close();
const script=`import sqlite3, json
from app.config import get_settings
s=get_settings()
c=sqlite3.connect(s.db_path)
active=c.execute("SELECT COUNT(*) FROM jobs WHERE status NOT IN ('succeeded','failed','cancelled')").fetchone()[0]
if active: raise RuntimeError('Active local jobs: postpone snapshot')
t=sqlite3.connect('/tmp/bmusic-deployment.sqlite3')
c.backup(t)
t.execute("UPDATE profiles SET login_status='logged_out',bili_uid=NULL,nickname=NULL,last_verified_at=NULL,active_job_id=NULL")
t.execute("DELETE FROM profile_readers")
t.execute("UPDATE login_sessions SET status='expired' WHERE status='pending'")
t.commit();t.close();c.close()
print(json.dumps({'active_jobs': active, 'browser_profiles_exported': False}))
`;
function run(command,args,input){const result=spawnSync(command,args,{input,encoding:"utf8",maxBuffer:1024*1024});if(result.status!==0)throw new Error(result.stderr||result.stdout);return result.stdout;}
console.log(run("docker",["exec","-i","bili-ctf-audio-kernel","python","-"],script));
run("docker",["cp","bili-ctf-audio-kernel:/tmp/bmusic-deployment.sqlite3",path.join(data,"kernel/kernel.sqlite3")]);
await fs.cp(path.join(root,"kernel/storage/artifacts"),path.join(data,"kernel/artifacts"),{recursive:true,errorOnExist:true,force:false});
const summary={directory:data,appDatabase:true,kernelDatabase:true,audioCache:true,browserProfiles:false,requiresNewBilibiliLogin:true};
await fs.writeFile(path.join(import.meta.dirname,"private","data-summary.json"),JSON.stringify(summary,null,2));
console.log(JSON.stringify({directory:data,...summary}));
