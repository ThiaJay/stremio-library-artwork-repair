import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPoster, safePoster, decoratedPoster, safePosterForItem, validateSourceRoot, operationFor,
  sameExceptArtworkAndMtime, recordHash, DEFAULT_IMAGE_HOSTS, applyOperation, createPlan
} from "../src/core.js";

test("canonical RPDB-style proxy unwraps to trusted fallback",()=>{
  const fallback="https://artworks.thetvdb.com/banners/posters/75897-5.jpg";
  const proxy="https://example.invalid/poster-cache/proxy/poster/series/tt0121955?fallback="+encodeURIComponent(fallback)+"&key=t3-example";
  assert.equal(canonicalPoster(proxy),fallback);
});
test("canonical helper can recover the trusted fallback from decorated wrappers",()=>{
  const fallback="https://image.tmdb.org/t/p/w500/a.jpg";
  const proxy="https://example.invalid/poster-cache/proxy/poster/movie/tt12345?fallback="+encodeURIComponent(fallback)+"&key=TP-custom";
  assert.equal(canonicalPoster(proxy),fallback);
});
test("unsafe or missing fallbacks remain untouched",()=>{
  const local="https://example.invalid/poster-cache/proxy/poster/movie/tt12345?fallback="+encodeURIComponent("http://127.0.0.1/a.jpg");
  assert.equal(canonicalPoster(local),local);
  const missing="https://example.invalid/poster-cache/proxy/poster/movie/tt12345?fallback="+encodeURIComponent("https://image.tmdb.org/missing_poster.png");
  assert.equal(canonicalPoster(missing),missing);
});
test("source roots reject local, IP, query and non-https targets",()=>{
  for(const u of ["http://example.com","https://127.0.0.1/x","https://localhost/x","https://example.com/x?a=1"]) assert.throws(()=>validateSourceRoot(u));
  assert.equal(validateSourceRoot("https://example.com/stremio/abc/manifest.json"),"https://example.com/stremio/abc");
});
test("safe poster requires exact HTTPS allowlist host",()=>{
  assert.equal(safePoster("https://image.tmdb.org/a.jpg"),true);
  assert.equal(safePoster("https://evil.example/a.jpg"),false);
});
test("identity-bound AIOMetadata decorated poster is accepted without allowlisting its wrapper host",()=>{
  const fallback="https://artworks.thetvdb.com/banners/posters/75897-5.jpg";
  const proxy="https://demo-aiometadata.elfhosted.com/poster-cache/proxy/poster/series/tt12345?fallback="+encodeURIComponent(fallback)+"&key=t3-example";
  assert.ok(decoratedPoster(proxy,"series","tt12345"));
  assert.equal(safePosterForItem(proxy,"series","tt12345"),true);
  assert.equal(decoratedPoster(proxy,"series","tt99999"),null);
  assert.equal(decoratedPoster(proxy,"movie","tt12345"),null);
});
test("decorated poster requires a safe canonical fallback and approved AIOMetadata host shape",()=>{
  const unsafe="https://demo-aiometadata.elfhosted.com/poster-cache/proxy/poster/series/tt12345?fallback="+encodeURIComponent("http://127.0.0.1/a.jpg")+"&key=t3-example";
  const other="https://evil.example/poster-cache/proxy/poster/series/tt12345?fallback="+encodeURIComponent("https://image.tmdb.org/t/p/w500/a.jpg")+"&key=t3-example";
  assert.equal(decoratedPoster(unsafe,"series","tt12345"),null);
  assert.equal(decoratedPoster(other,"series","tt12345"),null);
});
test("operation preserves current identity-bound decorated ratings poster",()=>{
  const fallback="https://image.tmdb.org/t/p/w500/new.jpg";
  const proxy="https://demo-aiometadata.elfhosted.com/poster-cache/proxy/poster/movie/tt12345?fallback="+encodeURIComponent(fallback)+"&key=t3-example";
  const item={_id:"tt12345",type:"movie",poster:"https://images.metahub.space/poster/old",_mtime:"2026-01-01",state:{timeOffset:9}};
  const op=operationFor(item,{id:"tt12345",type:"movie",poster:proxy});
  assert.equal(op.nextPoster,proxy);
  assert.equal(op.reason,"identity-bound-decorated-current");
});
test("operation changes only stale artwork and binds full before-state hash",()=>{
  const item={_id:"tt12345",type:"movie",poster:"https://images.metahub.space/poster/old",_mtime:"2026-01-01",state:{timeOffset:9},future:{x:1}};
  const meta={id:"tt12345",type:"movie",poster:"https://image.tmdb.org/t/p/w500/new.jpg"};
  const op=operationFor(item,meta);
  assert.equal(op.nextPoster,meta.poster);
  assert.equal(op.beforeHash,recordHash(item));
  assert.deepEqual(op.before,item);
});
test("verification comparison permits only artwork and mtime",()=>{
  const a={_id:"tt12345",type:"movie",poster:"a",posterShape:"poster",_mtime:"1",state:{timeOffset:9}};
  assert.equal(sameExceptArtworkAndMtime(a,{...a,poster:"b",_mtime:"2"}),true);
  assert.equal(sameExceptArtworkAndMtime(a,{...a,poster:"b",state:{timeOffset:10}}),false);
});
test("default hosts are deliberately narrow",()=>{
  assert.deepEqual(DEFAULT_IMAGE_HOSTS,["image.tmdb.org","artworks.thetvdb.com","images.metahub.space"]);
});

function mutationFixture({changeOnConfirm=false,mutateReadback=false,staleReadbacksAfterPut=0}={}){
  const planned={_id:"tt12345",name:"Example",type:"movie",poster:"https://images.metahub.space/poster/old",posterShape:"poster",removed:false,temp:false,_mtime:"2026-01-01T00:00:00Z",state:{timeOffset:9},future:{x:1}};
  let current=structuredClone(planned),getCount=0,puts=0,prePut=null,staleLeft=staleReadbacksAfterPut;
  const fetchImpl=async(url,init={})=>{
    const endpoint=String(url).split("/").pop();
    const body=JSON.parse(init.body||"{}");
    if(endpoint==="getUser")return Response.json({result:{_id:"account-1"}});
    if(endpoint==="datastoreGet"){
      getCount++;
      if(changeOnConfirm&&getCount===2)current={...current,name:"Changed elsewhere",_mtime:"2026-01-02T00:00:00Z"};
      if(puts>0&&staleLeft>0){staleLeft--;return Response.json({result:[structuredClone(prePut)]});}
      return Response.json({result:[structuredClone(current)]});
    }
    if(endpoint==="datastorePut"){
      puts++;
      prePut=structuredClone(current);
      current=structuredClone(body.changes[0]);
      if(mutateReadback)current.state={...current.state,timeOffset:10};
      return Response.json({result:{success:true}});
    }
    throw new Error("unexpected endpoint "+endpoint);
  };
  return {planned,fetchImpl,get puts(){return puts;},get current(){return current;}};
}

test("apply operation performs a second immediate pre-write concurrency check",async()=>{
  const f=mutationFixture({changeOnConfirm:true});
  const op={id:f.planned._id,type:f.planned.type,beforeHash:recordHash(f.planned),before:structuredClone(f.planned),nextPoster:"https://image.tmdb.org/t/p/w500/new.jpg"};
  await assert.rejects(applyOperation({authKey:"auth-key",account:await (async()=>{const u={_id:"account-1"};return (await import("node:crypto")).createHash("sha256").update("stremio:"+u._id).digest("hex");})(),operation:op,fetchImpl:f.fetchImpl}),e=>e?.code==="NEWER_ITEM_STATE_DETECTED");
  assert.equal(f.puts,0);
});

test("apply operation rejects unrelated post-write state drift",async()=>{
  const f=mutationFixture({mutateReadback:true});
  const crypto=await import("node:crypto"),account=crypto.createHash("sha256").update("stremio:account-1").digest("hex");
  const op={id:f.planned._id,type:f.planned.type,beforeHash:recordHash(f.planned),before:structuredClone(f.planned),nextPoster:"https://image.tmdb.org/t/p/w500/new.jpg"};
  await assert.rejects(applyOperation({authKey:"auth-key",account,operation:op,fetchImpl:f.fetchImpl}),e=>e?.code==="UNEXPECTED_STATE_CHANGE");
  assert.equal(f.puts,1);
});

test("apply operation accepts an identity-bound decorated poster and preserves unrelated state",async()=>{
  const f=mutationFixture();
  const crypto=await import("node:crypto"),account=crypto.createHash("sha256").update("stremio:account-1").digest("hex");
  const fallback="https://image.tmdb.org/t/p/w500/new.jpg";
  const decorated="https://demo-aiometadata.elfhosted.com/poster-cache/proxy/poster/movie/tt12345?fallback="+encodeURIComponent(fallback)+"&key=t3-example";
  const op={id:f.planned._id,type:f.planned.type,beforeHash:recordHash(f.planned),before:structuredClone(f.planned),nextPoster:decorated};
  const result=await applyOperation({authKey:"auth-key",account,operation:op,fetchImpl:f.fetchImpl});
  assert.equal(result.after.poster,decorated);
  assert.equal(sameExceptArtworkAndMtime(f.planned,result.after),true);
  assert.equal(f.puts,1);
});


test("apply operation tolerates one exact stale post-write readback then verifies the committed poster",async()=>{
  const f=mutationFixture({staleReadbacksAfterPut:1});
  const crypto=await import("node:crypto"),account=crypto.createHash("sha256").update("stremio:account-1").digest("hex");
  const nextPoster="https://image.tmdb.org/t/p/w500/new.jpg";
  const op={id:f.planned._id,type:f.planned.type,beforeHash:recordHash(f.planned),before:structuredClone(f.planned),nextPoster};
  const result=await applyOperation({authKey:"auth-key",account,operation:op,fetchImpl:f.fetchImpl});
  assert.equal(result.after.poster,nextPoster);
  assert.equal(sameExceptArtworkAndMtime(f.planned,result.after),true);
  assert.equal(f.puts,1);
});
