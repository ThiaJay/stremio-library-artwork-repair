const STREMIO_API="https://api.strem.io/api";
const DEFAULT_IMAGE_HOSTS=Object.freeze(["image.tmdb.org","artworks.thetvdb.com","images.metahub.space"]);
const AIOMETA_POSTER_HOST=/^[a-z0-9-]+-aiometadata\.elfhosted\.com$/i;
const SCAN_BATCH_SIZE=10;
const MAX_WRITES_PER_RUN=7;
const BACKUP_TTL_SECONDS=14*24*60*60;
const MAX_LIBRARY_ITEMS=20000;
const MAX_JSON_BYTES=12_000_000;
const SCHEDULE_INTERVAL_MS=10*60*1000;

class MaintenanceError extends Error{
  constructor(code,message=code){super(message);this.name="MaintenanceError";this.code=code;}
}
function assert(condition,code,message=code){if(!condition)throw new MaintenanceError(code,message);}

function canonicalValue(value){
  if(Array.isArray(value))return value.map(canonicalValue);
  if(value&&typeof value==="object"){
    const out={};
    for(const key of Object.keys(value).sort())out[key]=canonicalValue(value[key]);
    return out;
  }
  return value;
}
function canonicalJson(value){return JSON.stringify(canonicalValue(value));}
async function sha256Hex(value){
  const bytes=new TextEncoder().encode(String(value));
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function recordHash(value){return sha256Hex(canonicalJson(value));}

function isIpLiteral(host){
  return /^\d+(?:\.\d+){3}$/.test(host)||/^\[.*\]$/.test(host)||host.includes(":");
}
function safePoster(raw,allowedHosts=DEFAULT_IMAGE_HOSTS){
  if(typeof raw!=="string"||raw.length<8||raw.length>4096)return false;
  try{
    const u=new URL(raw),host=u.hostname.toLowerCase();
    return u.protocol==="https:"&&!u.username&&!u.password&&!u.hash&&(!u.port||u.port==="443")&&!isIpLiteral(host)&&allowedHosts.includes(host);
  }catch{return false;}
}
function canonicalPoster(raw,allowedHosts=DEFAULT_IMAGE_HOSTS){
  if(typeof raw!=="string")return raw;
  try{
    const u=new URL(raw);
    if(!/^\/(?:poster-cache\/proxy\/)?poster\/(?:movie|series)\/tt\d{5,12}$/i.test(u.pathname))return raw;
    const fallback=u.searchParams.get("fallback");
    if(!fallback||!safePoster(fallback,allowedHosts))return raw;
    const f=new URL(fallback);
    if(/\/missing_poster\.(?:png|jpe?g|webp)$/i.test(f.pathname))return raw;
    return f.toString();
  }catch{return raw;}
}
function decoratedPoster(raw,type,id,allowedHosts=DEFAULT_IMAGE_HOSTS){
  if(typeof raw!=="string"||!["movie","series"].includes(type)||!/^tt\d{5,12}$/.test(id))return null;
  try{
    const u=new URL(raw);
    if(u.protocol!=="https:"||u.username||u.password||u.hash||(u.port&&u.port!=="443"))return null;
    if(!AIOMETA_POSTER_HOST.test(u.hostname))return null;
    const m=u.pathname.match(/^\/(?:poster-cache\/proxy\/)?poster\/(movie|series)\/(tt\d{5,12})$/i);
    if(!m||m[1].toLowerCase()!==type||m[2]!==id)return null;
    const key=u.searchParams.get("key")||"";
    if(!key||key.length>256)return null;
    const fallback=u.searchParams.get("fallback");
    if(!fallback||!safePoster(fallback,allowedHosts))return null;
    const f=new URL(fallback);
    if(/\/missing_poster\.(?:png|jpe?g|webp)$/i.test(f.pathname))return null;
    return {url:u.toString(),fallback:f.toString(),host:u.hostname.toLowerCase()};
  }catch{return null;}
}
function safePosterForItem(raw,type,id,allowedHosts=DEFAULT_IMAGE_HOSTS){
  return safePoster(raw,allowedHosts)||!!decoratedPoster(raw,type,id,allowedHosts);
}
function sameExceptArtworkAndMtime(before,after){
  const a=structuredClone(before),b=structuredClone(after);
  delete a.poster;delete b.poster;delete a.posterShape;delete b.posterShape;delete a._mtime;delete b._mtime;
  return canonicalJson(a)===canonicalJson(b);
}
function eligibleItem(item){
  return !!item&&["movie","series"].includes(item.type)&&/^tt\d{5,12}$/.test(item._id)&&!(item.removed&&!item.temp);
}
function posterDecision(item,meta,allowedHosts=DEFAULT_IMAGE_HOSTS){
  if(!eligibleItem(item))return null;
  assert(meta?.id===item._id&&meta?.type===item.type,"METADATA_IDENTITY_MISMATCH");
  const decorated=decoratedPoster(meta.poster,item.type,item._id,allowedHosts);
  const nextPoster=decorated?decorated.url:canonicalPoster(meta.poster,allowedHosts);
  if(!safePosterForItem(nextPoster,item.type,item._id,allowedHosts)||item.poster===nextPoster)return null;
  return {id:item._id,type:item.type,before:structuredClone(item),nextPoster,reason:decorated?"identity-bound-decorated-current":nextPoster!==meta.poster?"canonical-fallback":"metadata-current"};
}

async function boundedJson(response,limit=MAX_JSON_BYTES){
  const type=(response.headers.get("content-type")||"").toLowerCase();
  assert(type.includes("json"),"UPSTREAM_NOT_JSON");
  const size=Number(response.headers.get("content-length")||0);
  assert(!size||size<=limit,"RESPONSE_TOO_LARGE");
  const bytes=new Uint8Array(await response.arrayBuffer());
  assert(bytes.byteLength<=limit,"RESPONSE_TOO_LARGE");
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new MaintenanceError("INVALID_JSON_RESPONSE");}
}
function transientStatus(status){return status===408||status===425||status===429||status>=500;}
async function sleep(ms){if(ms>0)await new Promise(r=>setTimeout(r,ms));}
async function stremioRead(env,endpoint,args={},deps={}){
  assert(typeof env.STREMIO_AUTHKEY==="string"&&env.STREMIO_AUTHKEY.length>=8,"STREMIO_AUTH_REQUIRED");
  assert(["getUser","datastoreGet"].includes(endpoint),"STREMIO_READ_ENDPOINT_BLOCKED");
  const fetchImpl=deps.fetchImpl||fetch;
  let last=null;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const response=await fetchImpl(`${STREMIO_API}/${endpoint}`,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({...args,authKey:env.STREMIO_AUTHKEY}),redirect:"manual",signal:AbortSignal.timeout(15000)
      });
      if(!response.ok){
        last=new MaintenanceError("STREMIO_HTTP_"+response.status);
        if(!transientStatus(response.status)||attempt===1)throw last;
      }else{
        const data=await boundedJson(response);
        return data.result;
      }
    }catch(error){
      last=error;
      if(error instanceof MaintenanceError&&!/^STREMIO_HTTP_(408|425|429|5\d\d)$/.test(error.code||""))throw error;
      if(attempt===1)throw error;
    }
    await (deps.sleep||sleep)(100*(attempt+1));
  }
  throw last||new MaintenanceError("STREMIO_READ_FAILED");
}
async function datastorePutOnce(env,candidate,deps={}){
  const fetchImpl=deps.fetchImpl||fetch;
  try{
    const response=await fetchImpl(`${STREMIO_API}/datastorePut`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({collection:"libraryItem",changes:[candidate],authKey:env.STREMIO_AUTHKEY}),
      redirect:"manual",signal:AbortSignal.timeout(15000)
    });
    if(!response.ok)return {kind:"http",status:response.status,transient:transientStatus(response.status)};
    const data=await boundedJson(response);
    const result=data.result;
    return result===true||result?.success===true?{kind:"confirmed"}:{kind:"negative"};
  }catch(error){return {kind:"network",error:String(error?.name||"network")};}
}
async function accountFingerprint(env,deps={}){
  const user=await stremioRead(env,"getUser",{},deps);
  const id=user?._id??user?.id;
  assert(typeof id==="string"&&id.length>0,"STREMIO_ACCOUNT_ID_MISSING");
  return sha256Hex("stremio:"+id);
}
async function getLibrary(env,ids=[],deps={}){
  assert(Array.isArray(ids)&&ids.length<=500,"INVALID_LIBRARY_IDS");
  const seen=new Set();
  for(const id of ids){
    assert(typeof id==="string"&&/^tt\d{5,12}$/.test(id),"INVALID_LIBRARY_ID");
    assert(!seen.has(id),"DUPLICATE_LIBRARY_ID");seen.add(id);
  }
  const rows=await stremioRead(env,"datastoreGet",{collection:"libraryItem",ids,all:ids.length===0},deps);
  assert(Array.isArray(rows)&&rows.length<=MAX_LIBRARY_ITEMS,"INVALID_STREMIO_LIBRARY");
  return rows;
}
async function metadataFor(env,item){
  assert(env.POSTER_SAFETY?.fetch,"POSTER_SAFETY_BINDING_REQUIRED");
  const response=await env.POSTER_SAFETY.fetch(new Request(`https://poster-safety.internal/meta/${item.type}/${encodeURIComponent(item._id)}.json`,{headers:{accept:"application/json"}}));
  assert(response.ok,"METADATA_HTTP_"+response.status);
  const data=await boundedJson(response,6_000_000);
  assert(data?.meta?.id===item._id&&data.meta.type===item.type,"METADATA_IDENTITY_MISMATCH");
  return data.meta;
}
function selectBatch(items,scheduledTime,batchSize=SCAN_BATCH_SIZE){
  assert(Number.isFinite(scheduledTime)&&scheduledTime>=0,"INVALID_SCHEDULE_TIME");
  assert(Number.isInteger(batchSize)&&batchSize>=1&&batchSize<=50,"INVALID_BATCH_SIZE");
  const sorted=items.filter(eligibleItem).sort((a,b)=>a._id.localeCompare(b._id)||a.type.localeCompare(b.type));
  if(!sorted.length)return {items:[],batchIndex:0,batchCount:0};
  const batchCount=Math.ceil(sorted.length/batchSize);
  const slot=Math.floor(scheduledTime/SCHEDULE_INTERVAL_MS);
  const batchIndex=((slot%batchCount)+batchCount)%batchCount;
  return {items:sorted.slice(batchIndex*batchSize,(batchIndex+1)*batchSize),batchIndex,batchCount};
}

function base64url(bytes){
  let binary="";for(const b of bytes)binary+=String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function fromBase64url(value){
  const padded=value.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((value.length+3)%4);
  const binary=atob(padded);return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
async function backupKey(secret){
  assert(typeof secret==="string"&&secret.length>=40,"BACKUP_KEY_REQUIRED");
  const bytes=fromBase64url(secret.trim());
  assert(bytes.byteLength===32,"BACKUP_KEY_INVALID");
  return crypto.subtle.importKey("raw",bytes,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function encryptBackup(value,secret){
  const plaintext=new TextEncoder().encode(canonicalJson(value));
  assert(plaintext.byteLength<=1_000_000,"BACKUP_TOO_LARGE");
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await backupKey(secret);
  const aad=new TextEncoder().encode("stremio-artwork-backup-v1");
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad},key,plaintext));
  return JSON.stringify({v:1,iv:base64url(iv),data:base64url(encrypted)});
}
async function decryptBackup(payload,secret){
  const parsed=typeof payload==="string"?JSON.parse(payload):payload;
  assert(parsed?.v===1&&typeof parsed.iv==="string"&&typeof parsed.data==="string","BACKUP_INVALID");
  const key=await backupKey(secret);
  const aad=new TextEncoder().encode("stremio-artwork-backup-v1");
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromBase64url(parsed.iv),additionalData:aad},key,fromBase64url(parsed.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function persistBackup(env,record){
  assert(env.BACKUP_DB?.prepare,"BACKUP_DB_REQUIRED");
  const idHash=await sha256Hex(record.before._id);
  const key=`v1/${record.createdAt.slice(0,10)}/${idHash.slice(0,16)}/${crypto.randomUUID()}`;
  const encrypted=await encryptBackup(record,env.BACKUP_ENCRYPTION_KEY);
  const createdAt=Date.parse(record.createdAt);
  const expiresAt=createdAt+BACKUP_TTL_SECONDS*1000;
  const result=await env.BACKUP_DB.prepare(
    "INSERT INTO artwork_backups (backup_key,created_at,expires_at,item_hash,payload) VALUES (?,?,?,?,?)"
  ).bind(key,createdAt,expiresAt,idHash.slice(0,16),encrypted).run();
  assert(result?.success!==false,"BACKUP_WRITE_FAILED");
  return key;
}
async function pruneExpiredBackups(env,scheduledTime){
  assert(env.BACKUP_DB?.prepare,"BACKUP_DB_REQUIRED");
  const result=await env.BACKUP_DB.prepare("DELETE FROM artwork_backups WHERE expires_at < ?").bind(scheduledTime).run();
  assert(result?.success!==false,"BACKUP_PRUNE_FAILED");
}
async function recordRunState(env,summary,scheduledTime){
  assert(env.BACKUP_DB?.prepare,"BACKUP_DB_REQUIRED");
  const result=await env.BACKUP_DB.prepare(
    "INSERT INTO maintenance_state (state_key,last_run,eligible,batch_index,batch_count,scanned,candidates,attempted_writes,verified_writes,stopped,error_codes) VALUES ('latest',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(state_key) DO UPDATE SET last_run=excluded.last_run,eligible=excluded.eligible,batch_index=excluded.batch_index,batch_count=excluded.batch_count,scanned=excluded.scanned,candidates=excluded.candidates,attempted_writes=excluded.attempted_writes,verified_writes=excluded.verified_writes,stopped=excluded.stopped,error_codes=excluded.error_codes"
  ).bind(
    scheduledTime,summary.eligible,summary.batchIndex,summary.batchCount,summary.scanned,summary.candidates,
    summary.attemptedWrites,summary.verifiedWrites,summary.stopped?1:0,JSON.stringify(summary.errorCodes||[])
  ).run();
  assert(result?.success!==false,"RUN_STATE_WRITE_FAILED");
}

async function verifyReadback(env,before,nextPoster,deps={}){
  let after=null;
  for(let attempt=0;attempt<4;attempt++){
    const rows=await getLibrary(env,[before._id],deps);
    assert(rows.length===1,"WRITE_READBACK_MISSING");
    after=rows[0];
    if(after.poster===nextPoster&&sameExceptArtworkAndMtime(before,after))return after;
    if(await recordHash(after)!==await recordHash(before)){
      if(!sameExceptArtworkAndMtime(before,after))throw new MaintenanceError("UNEXPECTED_STATE_CHANGE");
      throw new MaintenanceError("WRITE_READBACK_POSTER_MISMATCH");
    }
    if(attempt<3)await (deps.sleep||sleep)(150*(2**attempt));
  }
  throw new MaintenanceError("WRITE_READBACK_POSTER_MISMATCH");
}
async function applyCandidate(env,planned,expectedAccount,deps={}){
  assert(await accountFingerprint(env,deps)===expectedAccount,"ACCOUNT_CHANGED");
  assert(safePosterForItem(planned.nextPoster,planned.type,planned.id),"POSTER_HOST_NOT_ALLOWED");
  const rows=await getLibrary(env,[planned.id],deps);
  assert(rows.length===1&&rows[0]._id===planned.id&&rows[0].type===planned.type,"STREMIO_ITEM_MISSING");
  const before=rows[0];
  assert(await recordHash(before)===planned.beforeHash,"NEWER_ITEM_STATE_DETECTED");
  if(before.poster===planned.nextPoster)return {status:"ALREADY_CURRENT",backupKey:null};
  const confirm=await getLibrary(env,[planned.id],deps);
  assert(confirm.length===1&&await recordHash(confirm[0])===await recordHash(before),"NEWER_ITEM_STATE_DETECTED");
  const candidate=structuredClone(before);candidate.poster=planned.nextPoster;candidate._mtime=new Date((deps.now||Date.now)()).toISOString();
  const backupRecord={schema:2,createdAt:new Date((deps.now||Date.now)()).toISOString(),account:expectedAccount,before,candidate:{...before,poster:planned.nextPoster},reason:planned.reason};
  const key=await persistBackup(env,backupRecord);
  let outcome=await datastorePutOnce(env,candidate,deps);
  if(outcome.kind!=="confirmed"){
    const current=(await getLibrary(env,[planned.id],deps))[0];
    if(current?.poster===planned.nextPoster&&sameExceptArtworkAndMtime(before,current))return {status:"VERIFIED_AFTER_AMBIGUOUS_WRITE",backupKey:key};
    const stillBefore=current&&await recordHash(current)===await recordHash(before);
    if(stillBefore&&(outcome.kind==="network"||(outcome.kind==="http"&&outcome.transient))){
      outcome=await datastorePutOnce(env,candidate,deps);
      if(outcome.kind!=="confirmed"){
        const second=(await getLibrary(env,[planned.id],deps))[0];
        if(second?.poster===planned.nextPoster&&sameExceptArtworkAndMtime(before,second))return {status:"VERIFIED_AFTER_RETRY",backupKey:key};
        throw new MaintenanceError("STREMIO_WRITE_UNCONFIRMED");
      }
    }else throw new MaintenanceError("STREMIO_WRITE_UNCONFIRMED");
  }
  await verifyReadback(env,before,planned.nextPoster,deps);
  return {status:"VERIFIED",backupKey:key};
}

async function runMaintenance(env,scheduledTime=Date.now(),deps={}){
  assert(typeof env.EXPECTED_ACCOUNT_FINGERPRINT==="string"&&/^[0-9a-f]{64}$/i.test(env.EXPECTED_ACCOUNT_FINGERPRINT),"EXPECTED_ACCOUNT_REQUIRED");
  assert(typeof env.BACKUP_ENCRYPTION_KEY==="string","BACKUP_KEY_REQUIRED");
  assert(env.POSTER_SAFETY?.fetch,"POSTER_SAFETY_BINDING_REQUIRED");
  assert(env.BACKUP_DB?.prepare,"BACKUP_DB_REQUIRED");
  const expected=env.EXPECTED_ACCOUNT_FINGERPRINT.toLowerCase();
  assert(await accountFingerprint(env,deps)===expected,"ACCOUNT_CHANGED");
  const slot=Math.floor(scheduledTime/SCHEDULE_INTERVAL_MS);
  if(slot%144===0){
    try{await pruneExpiredBackups(env,scheduledTime);}catch(error){/* retention cleanup cannot authorize a write */ }
  }
  const library=await getLibrary(env,[],deps);
  const eligible=library.filter(eligibleItem);
  const batch=selectBatch(eligible,scheduledTime);
  const planned=[],errors=[];
  for(const item of batch.items){
    try{
      const meta=await metadataFor(env,item);
      const decision=posterDecision(item,meta);
      if(decision){
        decision.beforeHash=await recordHash(item);
        planned.push(decision);
      }
    }catch(error){errors.push(error?.code||"METADATA_UNAVAILABLE");}
  }
  let writes=0,verified=0,stopped=false;
  for(const op of planned.slice(0,MAX_WRITES_PER_RUN)){
    try{
      const result=await applyCandidate(env,op,expected,deps);
      writes++;if(result.status.startsWith("VERIFIED")||result.status==="ALREADY_CURRENT")verified++;
    }catch(error){errors.push(error?.code||"WRITE_FAILED");stopped=true;break;}
  }
  return {
    schema:1,
    eligible:eligible.length,
    batchIndex:batch.batchIndex,
    batchCount:batch.batchCount,
    scanned:batch.items.length,
    candidates:planned.length,
    attemptedWrites:writes,
    verifiedWrites:verified,
    stopped,
    errorCodes:[...new Set(errors)].slice(0,12)
  };
}

const worker={
  async fetch(){return new Response(JSON.stringify({error:"Not found"}),{status:404,headers:{"content-type":"application/json","cache-control":"no-store"}});},
  async scheduled(controller,env,ctx){
    const time=Number(controller?.scheduledTime||Date.now());
    const task=runMaintenance(env,time).then(async summary=>{
      try{await recordRunState(env,summary,time);}catch(error){
        console.log(JSON.stringify({event:"stremio-artwork-maintenance-heartbeat",error:error?.code||"RUN_STATE_WRITE_FAILED"}));
      }
      console.log(JSON.stringify({event:"stremio-artwork-maintenance",...summary}));
    }).catch(error=>{
      console.log(JSON.stringify({event:"stremio-artwork-maintenance",stopped:true,error:error?.code||"RUN_FAILED"}));
      throw error;
    });
    ctx?.waitUntil?ctx.waitUntil(task):await task;
  }
};

export {
  worker as default,MaintenanceError,DEFAULT_IMAGE_HOSTS,SCAN_BATCH_SIZE,MAX_WRITES_PER_RUN,BACKUP_TTL_SECONDS,
  canonicalJson,sha256Hex,recordHash,safePoster,canonicalPoster,decoratedPoster,safePosterForItem,
  sameExceptArtworkAndMtime,eligibleItem,posterDecision,selectBatch,encryptBackup,decryptBackup,
  persistBackup,pruneExpiredBackups,recordRunState,runMaintenance,applyCandidate,verifyReadback
};
