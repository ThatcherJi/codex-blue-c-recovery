import assert from 'node:assert/strict';
import {createResponseGuard} from '../codex-response-guard.mjs';
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function setup(extra={}) {
  let time=0, enabled=true;
  const calls=[], invalidators=new Map(), pending=new Map();
  const guard=createResponseGuard({now:()=>time,schedule:()=>1,cancel:()=>{},delay:100,ttl:2000,
    isEligible:w=>!w.dead,isEnabled:()=>enabled,pendingIds:w=>[...(pending.get(w)??[])],
    redeliver:(...args)=>calls.push(args),watch:(w,fn)=>{invalidators.set(w,fn);return()=>invalidators.delete(w);},...extra});
  const a={id:1}, b={id:2};
  const packet=id=>({channel:'codex_desktop:message-for-view',payload:{type:'fetch-response',responseType:'success',requestId:id,status:200,bodyJsonString:'{"ok":true}'}});
  return {guard,calls,invalidators,pending,a,b,packet,disable:()=>{enabled=false;},advance:async ms=>{time+=ms;await guard.tick();await flush();}};
}
let checks=0;
{
  const s=setup(), p=s.packet('write-ack');s.pending.set(s.a,new Set(['write-ack']));s.guard.capture(s.a,p);
  await s.advance(99);assert.equal(s.calls.length,0);
  await s.advance(1);assert.equal(s.calls.length,1);assert.equal(s.calls[0][1],p);assert.equal(s.calls[0][1].payload,p.payload);
  s.pending.get(s.a).clear();await s.advance(200);assert.equal(s.calls.length,1);assert.equal(s.guard.status().queued,0);assert.equal(s.guard.status().counts.acknowledged,1);checks++;
}
{
  const s=setup();s.guard.capture(s.a,s.packet('same'));s.guard.capture(s.b,s.packet('same'));s.pending.set(s.b,new Set(['same']));
  await s.advance(100);assert.equal(s.calls.length,1);assert.equal(s.calls[0][0],s.b);s.guard.stop();assert.equal(s.invalidators.size,0);checks++;
}
{
  let resolve;const s=setup({pendingIds:()=>new Promise(r=>{resolve=r;})});s.guard.capture(s.a,s.packet('old'));await s.advance(100);
  s.invalidators.get(s.a)();resolve(['old']);await flush();assert.equal(s.calls.length,0);assert.equal(s.guard.status().queued,0);checks++;
}
{
  const s=setup({maxEntries:2,maxBytes:10000});s.guard.capture(s.a,s.packet('one'));s.guard.capture(s.a,s.packet('two'));s.guard.capture(s.a,s.packet('three'));
  assert.equal(s.guard.status().queued,2);assert.equal(s.guard.status().counts.evicted,1);await s.advance(2001);assert.equal(s.calls.length,0);assert.equal(s.guard.status().bytes,0);checks++;
}
{
  const s=setup();s.guard.capture(s.a,s.packet('disabled'));s.pending.set(s.a,new Set(['disabled']));s.disable();await s.advance(100);
  assert.equal(s.calls.length,0);assert.equal(s.guard.status().active,false);checks++;
}
{
  let queries=0;const s=setup({pendingIds:()=>{queries++;return new Promise(()=>{});}});s.guard.capture(s.a,s.packet('hung'));
  await s.advance(100);await s.advance(100);await s.advance(2001);assert.equal(queries,1);assert.equal(s.calls.length,0);assert.equal(s.guard.status().queued,0);checks++;
}
{
  const s=setup({pendingIds:()=>Promise.reject(Error('renderer not ready'))});s.guard.capture(s.a,s.packet('failed'));await s.advance(100);
  assert.equal(s.calls.length,0);assert.equal(s.guard.status().counts.checkErrors,1);s.guard.stop();checks++;
}
{
  const s=setup({ttl:100000});s.pending.set(s.a,new Set(['lost']));s.guard.capture(s.a,s.packet('lost'));
  for(let i=0;i<10;i++)await s.advance(5000);
  assert.equal(s.calls.length,4);assert.equal(s.guard.status().queued,0);checks++;
}
{
  const s=setup({maxResponseBytes:300});const huge=s.packet('big');huge.payload.bodyJsonString='x'.repeat(300);s.guard.capture(s.a,huge);
  s.guard.capture(s.a,{channel:'another',payload:s.packet('wrong-channel').payload});
  s.guard.capture(s.a,{channel:'codex_desktop:message-for-view',payload:{type:'turn/start',requestId:'write-request'}});
  s.guard.capture(s.a,{channel:'codex_desktop:message-for-view',payload:{type:'chunk',requestId:'chunk'}});
  assert.equal(s.guard.status().queued,0);assert.equal(s.calls.length,0);checks++;
}
console.log(JSON.stringify({passed:true,checks,noRequestHandlerInvocations:true}));
