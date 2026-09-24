// Match the read-only registration guard while allowing bundler-generated identifiers to change.
export function isReadOnlyContextGetter(source) {
  const s = source.replace(/\s+/g, '');
  return /^(?:\()?([A-Za-z_$][\w$]*)(?:\))?=>([A-Za-z_$][\w$]*)\.hasRegisteredWebContents\(\1\)\?([A-Za-z_$][\w$]*):null$/.test(s);
}

// A fake target consumes both test packets; no real window receives a probe.
export function verifyDeliveryContract(deliver, owner) {
  if (typeof deliver !== 'function') throw Error('Unsupported delivery function');
  const sent = [];
  const target = {id:-1, send:(channel,payload)=>sent.push({channel,payload})};
  const payload = {type:'fetch-response',responseType:'success',requestId:'local-compatibility-probe',status:200,bodyJsonString:'null'};
  const part = {probe:'fragment'};
  const envelope = {channel:'codex_desktop:message-for-view',payload};
  for(const args of [[target,envelope],[target,envelope,part]]){
    const result=deliver.call(owner,...args);
    if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw Error('Unsupported asynchronous delivery behavior');}
  }
  if (sent.length!==2 || sent[0].channel!==envelope.channel || sent[1].channel!==envelope.channel ||
      sent[0].payload!==payload || sent[1].payload!==part) throw Error('Unsupported delivery behavior');
  return true;
}

// Export names may change between builds. Find the live client by its interface and validate
// its unbound reply handler against an isolated map, without touching application requests.
export function resolveCompatibleReplyClient(moduleExports) {
  const candidates = new Set();
  let unready=0;
  for (const value of Object.values(moduleExports)) {
    if (typeof value !== 'function') continue;
    const instance = Object.getOwnPropertyDescriptor(value,'instance')?.value;
    const pending = instance && Object.getOwnPropertyDescriptor(instance,'pendingRequests')?.value;
    const prototype = Object.getOwnPropertyDescriptor(value,'prototype')?.value;
    const handler = prototype && Object.getOwnPropertyDescriptor(prototype,'onFetchResponse')?.value;
    const request = prototype && Object.getOwnPropertyDescriptor(prototype,'sendRequest')?.value;
    if(typeof handler!=='function'||typeof request!=='function')continue;
    if(instance==null){unready++;continue;}
    if(!(pending instanceof Map))continue;
    candidates.add(value);
  }
  if(candidates.size===0&&unready>0)throw Error('Renderer reply client is not ready');
  if (candidates.size!==1) throw Error('Unsupported renderer reply interface');
  const Client=[...candidates][0];
  const handler=Object.getOwnPropertyDescriptor(Client.prototype,'onFetchResponse').value;
  const map=new Map(), fake={pendingRequests:map};
  let resolved=0,rejected=0,cleaned=0,result;
  const entry=()=>({resolve:v=>{resolved++;result=v;},reject:()=>{rejected++;},cleanup:()=>{cleaned++;}});
  const ok={type:'fetch-response',responseType:'success',requestId:'local-compatibility-success',status:200,headers:{},bodyJsonString:'{"probe":true}'};
  map.set(ok.requestId,entry());handler.call(fake,ok);
  if(map.size!==0||resolved!==1||rejected!==0||cleaned!==1||result?.status!==200||result?.body?.probe!==true)throw Error('Unsupported successful reply behavior');
  handler.call(fake,ok);
  if(resolved!==1||rejected!==0||cleaned!==1)throw Error('Unsupported duplicate reply behavior');
  const error={type:'fetch-response',responseType:'error',requestId:'local-compatibility-error',status:432,error:'probe'};
  map.set(error.requestId,entry());handler.call(fake,error);
  if(map.size!==0||resolved!==1||rejected!==1||cleaned!==2)throw Error('Unsupported error reply behavior');
  return Client.instance;
}
