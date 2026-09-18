import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {decryptBackup} from "../src/worker.js";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const PRIVATE=path.join(ROOT,".private");
const CONFIG=path.join(ROOT,"wrangler.local.toml");
const KEY_FILE=path.join(PRIVATE,"hosted-backup-encryption-key.txt");
const WRANGLER=path.join(ROOT,"node_modules",".bin",process.platform==="win32"?"wrangler.cmd":"wrangler");
const DB="stremio-library-artwork-maintenance";
function fail(code){console.error(JSON.stringify({error:code}));process.exit(1);}
function sql(command){
  const args=["d1","execute",DB,"--remote","--config",CONFIG,"--command",command,"--json"];
  const r=process.platform==="win32"
    ? spawnSync(process.env.ComSpec||"cmd.exe",["/d","/c",WRANGLER,...args],{cwd:ROOT,encoding:"utf8",windowsHide:true})
    : spawnSync(WRANGLER,args,{cwd:ROOT,encoding:"utf8",windowsHide:true});
  if(r.status!==0)fail("WRANGLER_FAILED");
  try{
    const parsed=JSON.parse(String(r.stdout||"[]"));
    if(!Array.isArray(parsed)||!parsed[0]?.success)fail("D1_RESULT_INVALID");
    return parsed[0].results??[];
  }catch{fail("D1_RESULT_INVALID");}
}
if(!fs.existsSync(CONFIG))fail("PRIVATE_WRANGLER_CONFIG_REQUIRED");
const command=process.argv[2]||"help";
if(command==="help"){
  console.log("Hosted backup admin: list | export <backup-key>");
  process.exit(0);
}
if(command==="list"){
  const rows=sql("SELECT backup_key,created_at,expires_at,item_hash FROM artwork_backups ORDER BY created_at DESC LIMIT 100");
  console.log(JSON.stringify(rows.map(x=>({key:x.backup_key,createdAt:x.created_at,expiresAt:x.expires_at,itemHash:x.item_hash})),null,2));
  process.exit(0);
}
if(command==="export"){
  const backupKey=process.argv[3];
  if(!backupKey||!/^v1\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{16}\/[0-9a-f-]{36}$/.test(backupKey))fail("BACKUP_KEY_INVALID");
  if(!fs.existsSync(KEY_FILE))fail("BACKUP_ENCRYPTION_KEY_REQUIRED");
  const escaped=backupKey.replace(/'/g,"''");
  const rows=sql("SELECT payload FROM artwork_backups WHERE backup_key='"+escaped+"' LIMIT 1");
  if(rows.length!==1||typeof rows[0].payload!=="string")fail("BACKUP_NOT_FOUND");
  const key=fs.readFileSync(KEY_FILE,"utf8").trim();
  const backup=await decryptBackup(rows[0].payload,key);
  fs.mkdirSync(PRIVATE,{recursive:true});
  const file=path.join(PRIVATE,"hosted-backup-"+new Date().toISOString().replace(/[:.]/g,"-")+".json");
  fs.writeFileSync(file,JSON.stringify(backup,null,2)+"\n",{encoding:"utf8",flag:"wx",mode:0o600});
  console.log(JSON.stringify({status:"EXPORTED",file,schema:backup.schema,createdAt:backup.createdAt??null},null,2));
  process.exit(0);
}
fail("UNKNOWN_COMMAND");
