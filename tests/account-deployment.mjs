// Local, metadata-only migration backup and audit. Never reads kernel cookies.
import {DatabaseSync,backup} from "node:sqlite";
import {createHash,randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
const root=path.resolve(import.meta.dirname,"..");
const database=path.join(root,"bili-music-app/data/bili-music-app.sqlite");
const reports=path.join(root,"tests/mobile-api/reports");
const checkpoint=path.join(reports,"account-deployment-checkpoint.json");
await fs.mkdir(reports,{recursive:true});
const tables=["favorite_videos","preferred_creators","playlists","playlist_items","tracks","candidate_interactions","playback_ranges"];
function snapshot(db){
  return Object.fromEntries(tables.map(table=>{
    const rows=db.prepare("SELECT * FROM "+table).all().map(row=>{
      const {external_owner_id,owner_id,...metadata}=row;
      return metadata;
    }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return [table,{count:rows.length,sha256:createHash("sha256").update(JSON.stringify(rows)).digest("hex")}];
  }));
}
if(process.argv[2]==="before"){
  const source=new DatabaseSync(database,{readOnly:true});
  const target=path.join(root,"bili-music-app/data/account-migration-backup-"+randomUUID()+".sqlite");
  await backup(source,target);source.close();
  const copy=new DatabaseSync(target,{readOnly:true});
  const data={backup:target,metadata:snapshot(copy)};copy.close();
  await fs.writeFile(checkpoint,JSON.stringify(data,null,2));
  console.log(JSON.stringify(data));
}else if(process.argv[2]==="after"){
  const before=JSON.parse(await fs.readFile(checkpoint,"utf8"));
  const source=new DatabaseSync(database,{readOnly:true});
  const after=snapshot(source);
  const migration=source.prepare("SELECT migration_key,target_owner_id FROM library_migrations WHERE migration_key='account-library-v1:local'").get();
  source.close();
  const changes=tables.filter(table=>before.metadata[table].sha256!==after[table].sha256);
  const result={at:new Date().toISOString(),unchangedMetadata:changes.length===0,changedTables:changes,backup:before.backup,migratedToBilibiliAccount:Boolean(migration?.target_owner_id?.startsWith("bili:")),counts:Object.fromEntries(tables.map(table=>[table,after[table].count]))};
  await fs.writeFile(path.join(reports,randomUUID()+"-account-deployment.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  if(changes.length||!result.migratedToBilibiliAccount)process.exitCode=1;
}else throw new Error("Use before or after");
