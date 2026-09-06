// Package the current source (including uncommitted fixes), excluding private data.
import fs from "node:fs";
import path from "node:path";
import {execFileSync,spawn} from "node:child_process";
const root=path.resolve(import.meta.dirname,"..");
const tag=process.argv[2];
if(!tag||!/^[a-zA-Z0-9_.-]+$/.test(tag))throw new Error("Release tag required");
const listed=execFileSync("git",["-c",`safe.directory=${root.replaceAll("\\","/")}`,"ls-files","--cached","--others","--exclude-standard","-z"],{cwd:root,encoding:"utf8"});
const files=[...new Set(listed.split("\0").filter(Boolean))].filter(file=>fs.existsSync(path.join(root,file)));
for(const file of files){
  if(/(^|[\\/])(?:http-session\.json|\.http-session-[^\\/]*)$/.test(file))throw new Error("Refusing kernel session journal: "+file);
  if(!fs.lstatSync(path.join(root,file)).isFile())throw new Error("Refusing non-regular source entry: "+file);
  if(path.isAbsolute(file)||file.split(/[\\/]/).includes("..")||/(^|\/)(?:private|bundles|node_modules|\.next|\.git|storage|reports)(\/|$)/.test(file)&&!file.endsWith("/.gitkeep")||/\.(?:key|pem|sqlite3?|db|mp3|m4a|mp4|tar\.gz)$/.test(file)||/(^|\/)\.env($|\.)/.test(file)&&!file.endsWith(".env.example"))throw new Error("Refusing potentially private archive entry: "+file);
}
const directory=path.join(import.meta.dirname,"bundles");fs.mkdirSync(directory,{recursive:true});
const output=path.join(directory,"source-"+tag+".tar.gz");
if(fs.existsSync(output))throw new Error("Source archive already exists; use a new release tag");
const child=spawn("tar",["-czf",output,"--null","-T","-"],{cwd:root,stdio:["pipe","inherit","inherit"]});
const done=new Promise((resolve,reject)=>{child.on("error",reject);child.on("exit",code=>code===0?resolve():reject(new Error("tar exit "+code)));});
child.stdin.end(files.join("\0")+"\0");await done;
console.log(JSON.stringify({file:output,entries:files.length,bytes:fs.statSync(output).size}));
