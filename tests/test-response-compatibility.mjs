import assert from 'node:assert/strict';
import {isReadOnlyContextGetter,verifyDeliveryContract,resolveCompatibleReplyClient} from '../codex-response-compatibility.mjs';
let checks=0;
for(const s of ['e=>B.hasRegisteredWebContents(e)?z:null',' (window42) => registry_9.hasRegisteredWebContents(window42) ? contextNew : null'])assert.equal(isReadOnlyContextGetter(s),true);
for(const s of ['e=>B.hasRegisteredWebContents(x)?z:null','e=>(delete z.state,B.hasRegisteredWebContents(e)?z:null)','e=>B.hasRegisteredWebContents(e)?z:other','e=>writeSomething(e)'])assert.equal(isReadOnlyContextGetter(s),false);
checks++;
const owner={};assert.equal(verifyDeliveryContract((w,e,p)=>w.send(e.channel,p??e.payload),owner),true);checks++;
assert.throws(()=>verifyDeliveryContract((w,e,p)=>w.send('wrong',p??e.payload),owner),/Unsupported/);checks++;
assert.throws(()=>verifyDeliveryContract((w,e,p)=>w.send(e.channel,e.payload),owner),/Unsupported/);checks++;
assert.throws(()=>verifyDeliveryContract(async()=>{throw Error('async');},owner),/Unsupported/);checks++;
function fixture(){
  return class DifferentMinifiedName{
    static instance={pendingRequests:new Map([['real-user-request',{untouched:true}]])};
    sendRequest(){throw Error('A compatibility check must never send a request');}
    onFetchResponse(response){const p=this.pendingRequests.get(response.requestId);if(!p)return;this.pendingRequests.delete(response.requestId);p.cleanup?.();if(response.responseType==='success')p.resolve({status:response.status,headers:response.headers,body:JSON.parse(response.bodyJsonString)});else p.reject(new Error(response.error));}
  };
}
const Old=fixture(),Renamed=fixture();
assert.equal(resolveCompatibleReplyClient({_dn:Old}),Old.instance);
assert.equal(resolveCompatibleReplyClient({someNewExportAlias:Renamed}),Renamed.instance);
assert.deepEqual([...Renamed.instance.pendingRequests],[['real-user-request',{untouched:true}]]);checks++;
assert.throws(()=>resolveCompatibleReplyClient({x:Old,y:Renamed}),/Unsupported/);checks++;
class Broken {static instance={pendingRequests:new Map()};sendRequest(){}onFetchResponse(r){this.pendingRequests.get(r.requestId)?.resolve({status:200,body:{probe:true}});}}
assert.throws(()=>resolveCompatibleReplyClient({changed:Broken}),/Unsupported/);checks++;
class Starting {static instance=null;sendRequest(){}onFetchResponse(){}}
assert.throws(()=>resolveCompatibleReplyClient({futureName:Starting}),e=>e.message.includes('not ready')&&!e.message.includes('Unsupported'));checks++;
const getterHolder={};Object.defineProperty(getterHolder,'instance',{get(){throw Error('Must not execute getters');}});
assert.throws(()=>resolveCompatibleReplyClient({getterHolder}),/Unsupported/);checks++;
console.log(JSON.stringify({passed:true,checks,renamedGetterAccepted:true,renamedExportAccepted:true,liveRequestsUntouched:true,incompatibleProtocolsRejected:true}));
