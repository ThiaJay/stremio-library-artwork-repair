import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPoster, safePoster, validateSourceRoot, operationFor,
  sameExceptArtworkAndMtime, recordHash, DEFAULT_IMAGE_HOSTS, applyOperation, createPlan
} from "../src/core.js";

test("canonical RPDB-style proxy unwraps to trusted fallback",()=>{
  const fallback="https://artworks.thetvdb.com/banners/posters/75897-5.jpg";
  const proxy="https://example.invalid/poster-cache/proxy/poster/series/tt0121955?fallback="+encodeURIComponent(fallback)+"&key=t3-example";
  assert.equal(canonicalPoster(proxy),fallback);
});
test("Top Poster selection is preserved",()=>{
  const fallback="https://image.tmdb.org/t/p/w500/a.jpg";
  const proxy="https://example.invalid/poster-cache/proxy/poster/movie/tt12345?fallback="+encodeURIComponent(fallback)+"&key=TP-custom";
  assert.equal(canonicalPoster(proxy),proxy);
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

function mutationFixture({changeOnConfirm=false,mutateReadback=false}={}){
  const planned={_id:"tt12345",name:"Example",type:"movie",poster:"https://images.metahub.space/poster/old",posterShape:"poster",removed:false,temp:false,_mtime:"2026-01-01T00:00:00Z",state:{timeOffset:9},future:{x:1}};
  let current=structuredClone(planned),getCount=0,puts=0;
  const fetchImpl=async(url,init={})=>{
    const endpoint=String(url).split("/").pop();
    const body=JSON.parse(init.body||"{}");
    if(endpoint==="getUser")return Response.json({result:{_id:"account-1"}});
    if(endpoint==="datastoreGet"){
      getCount++;
      if(changeOnConfirm&&getCount===2)current={...current,name:"Changed elsewhere",_mtime:"2026-01-02T00:00:00Z"};
      return Response.json({result:[structuredClone(current)]});
    }
    if(endpoint==="datastorePut"){
      puts++;
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
