import test from "node:test";
import assert from "node:assert/strict";
import worker,{
  SCAN_BATCH_SIZE,MAX_WRITES_PER_RUN,BACKUP_TTL_SECONDS,sha256Hex,recordHash,
  safePoster,decoratedPoster,posterDecision,selectBatch,encryptBackup,decryptBackup,
  recordRunState,runMaintenance,applyCandidate,sameExceptArtworkAndMtime
} from "../src/worker.js";

const fallback="https://artworks.thetvdb.com/banners/posters/75897-5.jpg";
const decorated=(id="tt12345",type="series") =>
  "https://demo-aiometadata.elfhosted.com/poster-cache/proxy/poster/"+type+"/"+id+
  "?fallback="+encodeURIComponent(fallback)+"&key=t3-example";

function item(id="tt12345",type="series",poster="https://images.metahub.space/poster/old"){
  return {_id:id,type,name:"Example",poster,posterShape:"poster",removed:false,temp:false,_mtime:"1",state:{timeOffset:9,watched:"abc"},future:{x:1}};
}
class MemoryDB{
  constructor({fail=false}={}){this.rows=new Map();this.fail=fail;this.puts=0;this.deletes=0;}
  prepare(sql){
    const self=this;
    return {
      bind(...args){
        return {
          async run(){
            if(self.fail)throw new Error("db unavailable");
            if(sql.startsWith("INSERT INTO artwork_backups")){
              self.puts++;
              const [key,createdAt,expiresAt,itemHash,payload]=args;
              self.rows.set(key,{key,createdAt,expiresAt,itemHash,payload});
              return {success:true};
            }
            if(sql.startsWith("DELETE FROM artwork_backups")){
              self.deletes++;
              const [cutoff]=args;
              for(const [key,row] of self.rows) if(row.expiresAt<cutoff) self.rows.delete(key);
              return {success:true};
            }
            if(sql.startsWith("INSERT INTO maintenance_state")){
              self.state=args;
              return {success:true};
            }
            throw new Error("unexpected sql");
          }
        };
      }
    };
  }
}
function posterBinding(metaById){
  return {fetch:async request=>{
    const m=new URL(request.url).pathname.match(/^\/meta\/(movie|series)\/(tt\d+)\.json$/);
    if(!m)return Response.json({error:"not found"},{status:404});
    const meta=metaById[m[2]];
    return meta?Response.json({meta}):Response.json({error:"not found"},{status:404});
  }};
}
async function accountHash(){return sha256Hex("stremio:account-1");}

function stremioFixture({
  rows=[item()],
  accountId="account-1",
  changeOnSecondRead=false,
  staleReadbacks=0,
  driftAfterPut=false,
  ambiguousFirstWrite=false,
  ambiguousApplied=false
}={}){
  let library=structuredClone(rows),getsById=new Map(),puts=0,staleLeft=staleReadbacks,prePut=null,firstWrite=true;
  const fetchImpl=async(url,init={})=>{
    const endpoint=String(url).split("/").pop();
    const body=JSON.parse(init.body||"{}");
    if(endpoint==="getUser")return Response.json({result:{_id:accountId}});
    if(endpoint==="datastoreGet"){
      if(body.all)return Response.json({result:structuredClone(library)});
      const id=body.ids?.[0];
      const n=(getsById.get(id)||0)+1;getsById.set(id,n);
      let current=library.find(x=>x._id===id);
      if(changeOnSecondRead&&n===2){
        current={...current,name:"changed elsewhere",_mtime:"2"};
        library=library.map(x=>x._id===id?current:x);
      }
      if(puts>0&&staleLeft>0){staleLeft--;return Response.json({result:[structuredClone(prePut)]});}
      return Response.json({result:current?[structuredClone(current)]:[]});
    }
    if(endpoint==="datastorePut"){
      puts++;
      const candidate=structuredClone(body.changes[0]);
      const current=library.find(x=>x._id===candidate._id);
      prePut=structuredClone(current);
      if(ambiguousFirstWrite&&firstWrite){
        firstWrite=false;
        if(ambiguousApplied)library=library.map(x=>x._id===candidate._id?candidate:x);
        throw new DOMException("timeout","AbortError");
      }
      library=library.map(x=>x._id===candidate._id?candidate:x);
      if(driftAfterPut){
        library=library.map(x=>x._id===candidate._id?{...x,state:{...x.state,timeOffset:10}}:x);
      }
      return Response.json({result:{success:true}});
    }
    throw new Error("unexpected "+endpoint);
  };
  return {fetchImpl,get library(){return library},get puts(){return puts},get gets(){return getsById}};
}

test("poster policy preserves identity-bound decoration and rejects wrong identity",()=>{
  const current=item();
  const good={id:"tt12345",type:"series",poster:decorated()};
  const decision=posterDecision(current,good);
  assert.equal(decision.nextPoster,decorated());
  assert.equal(decision.reason,"identity-bound-decorated-current");
  assert.throws(()=>posterDecision(current,{...good,id:"tt99999"}),/METADATA_IDENTITY_MISMATCH/);
  assert.equal(decoratedPoster(decorated("tt99999"),"series","tt12345"),null);
  assert.equal(safePoster("https://evil.example/x.jpg"),false);
});

test("batch selector gives deterministic bounded coverage",()=>{
  const rows=Array.from({length:43},(_,i)=>item("tt"+String(10000+i)));
  const seen=new Set();
  const count=Math.ceil(rows.length/SCAN_BATCH_SIZE);
  for(let slot=0;slot<count;slot++){
    const b=selectBatch(rows,slot*10*60*1000);
    assert.ok(b.items.length<=SCAN_BATCH_SIZE);
    for(const row of b.items)seen.add(row._id);
  }
  assert.equal(seen.size,43);
});

test("encrypted backup round-trip does not contain plaintext record",async()=>{
  const keyBytes=new Uint8Array(32);crypto.getRandomValues(keyBytes);
  const key=btoa(String.fromCharCode(...keyBytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const value={before:item(),secretMarker:"do-not-leak"};
  const encrypted=await encryptBackup(value,key);
  assert.equal(encrypted.includes("do-not-leak"),false);
  assert.deepEqual(await decryptBackup(encrypted,key),value);
});

test("automatic run repairs stale artwork with encrypted backup and leaves unrelated state unchanged",async()=>{
  const f=stremioFixture();
  const db=new MemoryDB();
  const env={
    STREMIO_AUTHKEY:"auth-key-value",
    EXPECTED_ACCOUNT_FINGERPRINT:await accountHash(),
    BACKUP_ENCRYPTION_KEY:(()=>{const b=new Uint8Array(32);crypto.getRandomValues(b);return btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")})(),
    BACKUP_DB:db,
    POSTER_SAFETY:posterBinding({tt12345:{id:"tt12345",type:"series",poster:decorated()}})
  };
  const before=structuredClone(f.library[0]);
  const summary=await runMaintenance(env,0,{fetchImpl:f.fetchImpl,sleep:async()=>{},now:()=>1000});
  assert.equal(summary.verifiedWrites,1);
  assert.equal(f.library[0].poster,decorated());
  assert.equal(sameExceptArtworkAndMtime(before,f.library[0]),true);
  assert.equal(db.puts,1);
  const stored=[...db.rows.values()][0];
  assert.equal(stored.expiresAt-stored.createdAt,BACKUP_TTL_SECONDS*1000);
});

test("already-current artwork causes no backup or write",async()=>{
  const current=item("tt12345","series",decorated());
  const f=stremioFixture({rows:[current]});
  const db=new MemoryDB();
  const env={
    STREMIO_AUTHKEY:"auth-key-value",EXPECTED_ACCOUNT_FINGERPRINT:await accountHash(),
    BACKUP_ENCRYPTION_KEY:(()=>{const b=new Uint8Array(32);crypto.getRandomValues(b);return btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")})(),
    BACKUP_DB:db,POSTER_SAFETY:posterBinding({tt12345:{id:"tt12345",type:"series",poster:decorated()}})
  };
  const summary=await runMaintenance(env,0,{fetchImpl:f.fetchImpl,sleep:async()=>{}});
  assert.equal(summary.candidates,0);assert.equal(f.puts,0);assert.equal(db.puts,0);
});

test("account mismatch fails before any library write",async()=>{
  const f=stremioFixture({accountId:"other-account"});
  const db=new MemoryDB();
  const env={
    STREMIO_AUTHKEY:"auth-key-value",EXPECTED_ACCOUNT_FINGERPRINT:await accountHash(),
    BACKUP_ENCRYPTION_KEY:"A".repeat(43),BACKUP_DB:db,POSTER_SAFETY:posterBinding({})
  };
  await assert.rejects(()=>runMaintenance(env,0,{fetchImpl:f.fetchImpl,sleep:async()=>{}}),e=>e?.code==="ACCOUNT_CHANGED");
  assert.equal(f.puts,0);
});

test("backup failure prevents account mutation",async()=>{
  const f=stremioFixture();
  const db=new MemoryDB({fail:true});
  const keyBytes=new Uint8Array(32);crypto.getRandomValues(keyBytes);
  const env={
    STREMIO_AUTHKEY:"auth-key-value",EXPECTED_ACCOUNT_FINGERPRINT:await accountHash(),
    BACKUP_ENCRYPTION_KEY:btoa(String.fromCharCode(...keyBytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    BACKUP_DB:db,POSTER_SAFETY:posterBinding({tt12345:{id:"tt12345",type:"series",poster:decorated()}})
  };
  const summary=await runMaintenance(env,0,{fetchImpl:f.fetchImpl,sleep:async()=>{}});
  assert.equal(summary.stopped,true);assert.equal(f.puts,0);
});

test("second immediate pre-write read blocks concurrent change",async()=>{
  const f=stremioFixture({changeOnSecondRead:true});
  const db=new MemoryDB();const kb=new Uint8Array(32);crypto.getRandomValues(kb);
  const env={
    STREMIO_AUTHKEY:"auth-key-value",EXPECTED_ACCOUNT_FINGERPRINT:await accountHash(),
    BACKUP_ENCRYPTION_KEY:btoa(String.fromCharCode(...kb)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    BACKUP_DB:db,POSTER_SAFETY:posterBinding({tt12345:{id:"tt12345",type:"series",poster:decorated()}})
  };
  const summary=await runMaintenance(env,0,{fetchImpl:f.fetchImpl,sleep:async()=>{}});
  assert.equal(summary.stopped,true);assert.equal(f.puts,0);assert.equal(db.puts,0);
});

test("one exact stale readback is tolerated",async()=>{
  const f=stremioFixture({staleReadbacks:1});
  const kb=new Uint8Array(32);crypto.getRandomValues(kb);
  const env={
    STREMIO_AUTHKEY:"auth-key-value",EXPECTED_ACCOUNT_FINGERPRINT:await accountHash(),
    BACKUP_ENCRYPTION_KEY:btoa(String.fromCharCode(...kb)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    BACKUP_DB:new MemoryDB(),POSTER_SAFETY:posterBinding({})
  };
  const before=structuredClone(f.library[0]);
  const op={id:"tt12345",type:"series",beforeHash:await recordHash(before),before,nextPoster:decorated(),reason:"test"};
  const result=await applyCandidate(env,op,await accountHash(),{fetchImpl:f.fetchImpl,sleep:async()=>{},now:()=>1000});
  assert.equal(result.status,"VERIFIED");assert.equal(f.library[0].poster,decorated());
});

test("unrelated post-write drift fails closed",async()=>{
  const f=stremioFixture({driftAfterPut:true});
  const kb=new Uint8Array(32);crypto.getRandomValues(kb);
  const env={
    STREMIO_AUTHKEY:"auth-key-value",EXPECTED_ACCOUNT_FINGERPRINT:await accountHash(),
    BACKUP_ENCRYPTION_KEY:btoa(String.fromCharCode(...kb)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    BACKUP_DB:new MemoryDB(),POSTER_SAFETY:posterBinding({})
  };
  const before=structuredClone(f.library[0]);
  const op={id:"tt12345",type:"series",beforeHash:await recordHash(before),before,nextPoster:decorated(),reason:"test"};
  const account=await accountHash();
  await assert.rejects(()=>applyCandidate(env,op,account,{fetchImpl:f.fetchImpl,sleep:async()=>{},now:()=>1000}),e=>e?.code==="UNEXPECTED_STATE_CHANGE");
});

test("ambiguous write that actually committed is resolved by readback without duplicate write",async()=>{
  const f=stremioFixture({ambiguousFirstWrite:true,ambiguousApplied:true});
  const kb=new Uint8Array(32);crypto.getRandomValues(kb);
  const env={
    STREMIO_AUTHKEY:"auth-key-value",EXPECTED_ACCOUNT_FINGERPRINT:await accountHash(),
    BACKUP_ENCRYPTION_KEY:btoa(String.fromCharCode(...kb)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    BACKUP_DB:new MemoryDB(),POSTER_SAFETY:posterBinding({})
  };
  const before=structuredClone(f.library[0]);
  const op={id:"tt12345",type:"series",beforeHash:await recordHash(before),before,nextPoster:decorated(),reason:"test"};
  const result=await applyCandidate(env,op,await accountHash(),{fetchImpl:f.fetchImpl,sleep:async()=>{},now:()=>1000});
  assert.equal(result.status,"VERIFIED_AFTER_AMBIGUOUS_WRITE");assert.equal(f.puts,1);
});

test("ambiguous write with exact unchanged record is retried once",async()=>{
  const f=stremioFixture({ambiguousFirstWrite:true,ambiguousApplied:false});
  const kb=new Uint8Array(32);crypto.getRandomValues(kb);
  const env={
    STREMIO_AUTHKEY:"auth-key-value",EXPECTED_ACCOUNT_FINGERPRINT:await accountHash(),
    BACKUP_ENCRYPTION_KEY:btoa(String.fromCharCode(...kb)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    BACKUP_DB:new MemoryDB(),POSTER_SAFETY:posterBinding({})
  };
  const before=structuredClone(f.library[0]);
  const op={id:"tt12345",type:"series",beforeHash:await recordHash(before),before,nextPoster:decorated(),reason:"test"};
  const result=await applyCandidate(env,op,await accountHash(),{fetchImpl:f.fetchImpl,sleep:async()=>{},now:()=>1000});
  assert.equal(result.status,"VERIFIED");assert.equal(f.puts,2);
});

test("metadata failures are skipped without blocking the rest of the batch",async()=>{
  const rows=[item("tt12345"),item("tt12346")];
  const f=stremioFixture({rows});
  const kb=new Uint8Array(32);crypto.getRandomValues(kb);
  const env={
    STREMIO_AUTHKEY:"auth-key-value",EXPECTED_ACCOUNT_FINGERPRINT:await accountHash(),
    BACKUP_ENCRYPTION_KEY:btoa(String.fromCharCode(...kb)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    BACKUP_DB:new MemoryDB(),POSTER_SAFETY:posterBinding({tt12346:{id:"tt12346",type:"series",poster:decorated("tt12346")}})
  };
  const summary=await runMaintenance(env,0,{fetchImpl:f.fetchImpl,sleep:async()=>{}});
  assert.equal(summary.scanned,2);assert.equal(summary.verifiedWrites,1);
  assert.ok(summary.errorCodes.some(x=>String(x).startsWith("METADATA_HTTP_")));
});

test("write cap is hard even when every scanned item is stale",async()=>{
  const rows=Array.from({length:10},(_,i)=>item("tt"+String(12000+i)));
  const metas=Object.fromEntries(rows.map(x=>[x._id,{id:x._id,type:"series",poster:decorated(x._id)}]));
  const f=stremioFixture({rows});
  const kb=new Uint8Array(32);crypto.getRandomValues(kb);
  const env={
    STREMIO_AUTHKEY:"auth-key-value",EXPECTED_ACCOUNT_FINGERPRINT:await accountHash(),
    BACKUP_ENCRYPTION_KEY:btoa(String.fromCharCode(...kb)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    BACKUP_DB:new MemoryDB(),POSTER_SAFETY:posterBinding(metas)
  };
  const summary=await runMaintenance(env,0,{fetchImpl:f.fetchImpl,sleep:async()=>{}});
  assert.equal(summary.candidates,10);assert.equal(summary.attemptedWrites,MAX_WRITES_PER_RUN);assert.equal(f.puts,MAX_WRITES_PER_RUN);
});

test("public fetch surface is closed",async()=>{
  const r=await worker.fetch(new Request("https://maintenance.example/"));
  assert.equal(r.status,404);assert.match(r.headers.get("cache-control")||"",/no-store/);
});


test("run heartbeat stores aggregate-only state",async()=>{
  const db=new MemoryDB();
  const summary={eligible:1432,batchIndex:4,batchCount:144,scanned:10,candidates:2,attemptedWrites:2,verifiedWrites:2,stopped:false,errorCodes:[]};
  await recordRunState({BACKUP_DB:db},summary,1234567890);
  assert.equal(db.state[0],1234567890);
  assert.equal(db.state[1],1432);
  assert.equal(db.state[8],0);
  assert.equal(db.state[9],"[]");
});
