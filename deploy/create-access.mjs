// Generate deployment credentials outside the App; never print or commit passwords.
import fs from "node:fs/promises";
import path from "node:path";
import {randomBytes} from "node:crypto";
const directory=path.join(import.meta.dirname,"private");
await fs.mkdir(directory,{recursive:true});
const file=path.join(directory,"access.json");
let access;
try{access=JSON.parse(await fs.readFile(file,"utf8"));}
catch(error){if(error.code!=="ENOENT")throw error;access={url:"https://bmusic.ftwegc.com",username:"bmusic",password:randomBytes(24).toString("base64url")};await fs.writeFile(file,JSON.stringify(access,null,2),{mode:0o600});}
await fs.writeFile(path.join(directory,"password"),access.password+"\n",{mode:0o600});
console.log("Credentials saved to "+file+" (not printed; excluded from Git).");
