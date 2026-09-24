import { createResponseGuard } from './codex-response-guard.mjs';
import { recoverLocalHomeReads } from './composer-read-recovery.mjs';
import { isReadOnlyContextGetter, verifyDeliveryContract, resolveCompatibleReplyClient } from './codex-response-compatibility.mjs';

export async function installResponseGuard(command, settings = {}) {
  const group = 'codex-response-guard-install';
  const prefix = "const req=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json');const electron=req('electron');";
  const props = objectId => command('Runtime.getProperties', {objectId, ownProperties: true});
  try {
    if(settings.remove){
      const r=await command('Runtime.evaluate',{expression:`(()=>{let removed=false;for(const n of ['codex.local-response-guard.v2','codex.local-response-guard.v1']){const g=globalThis[Symbol.for(n)];if(g){if(g.installationRoot!==${JSON.stringify(settings.dataRoot)})throw Error('Another recovery installation owns this hook');g.stop();removed=true;}}return {removed,pid:process.pid}})()`,returnByValue:true});
      if(r.exceptionDetails)throw Error(r.exceptionDetails.text);
      return r.result.value;
    }
    const fn = (await command('Runtime.evaluate', {expression: `(()=>{${prefix}return electron.ipcMain._invokeHandlers.get('codex_desktop:message-from-view')})()`, objectGroup:group})).result;
    if (!fn?.objectId) throw Error('Desktop bridge is not ready');
    const fp = await props(fn.objectId);
    const scopes = await props(fp.internalProperties.find(x => x.name === '[[Scopes]]').value.objectId);
    const getters=[];
    for(const scope of scopes.result.filter(x=>x.value?.objectId&&x.value.description?.startsWith('Closure')).slice(0,6)){
      const fields=await props(scope.value.objectId);
      for(const field of fields.result)if(field.value?.type==='function'&&isReadOnlyContextGetter(field.value.description??''))getters.push(field.value);
    }
    if(getters.length!==1)throw Error('Unsupported desktop context registration interface');
    const getter=getters[0];
    const ctx = await command('Runtime.callFunctionOn', {objectId:getter.objectId, functionDeclaration:`function(){${prefix}for(const w of electron.BrowserWindow.getAllWindows()){if(w.isDestroyed()||!w.webContents.getURL().startsWith('app://-/index.html'))continue;const c=this(w.webContents);if(c)return c;}throw Error('Desktop window is not ready')}`, objectGroup:group});
    if (ctx.exceptionDetails) throw Error(ctx.exceptionDetails.exception?.description ?? ctx.exceptionDetails.text);
    const result = await command('Runtime.callFunctionOn', {objectId:ctx.result.objectId, functionDeclaration:installInMain.toString(), arguments:[{value:createResponseGuard.toString()}, {value:settings}, {value:recoverLocalHomeReads.toString()}, {value:verifyDeliveryContract.toString()}, {value:resolveCompatibleReplyClient.toString()}], returnByValue:true, awaitPromise:true},18000);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  } finally { await command('Runtime.releaseObjectGroup', {objectGroup:group}).catch(()=>{}); }
}

async function installInMain(factorySource, settings, recoverySource, deliveryVerifierSource, clientResolverSource) {
  const req = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json');
  const fs = req('fs'), crypto = req('crypto');
  const key = Symbol.for('codex.local-response-guard.v2');
  const existing = globalThis[key];
  if (existing?.status().active&&!settings.probeOnly) {
    if(existing.installationRoot!==settings.dataRoot)throw Error('Another recovery installation owns this hook');
    return {installed:true, existing:true, pid:process.pid, status:existing.status()};
  }
  const assetRoot=process.resourcesPath+'/app.asar/webview/assets/';
  const assetNames=fs.readdirSync(assetRoot).filter(n=>/^app-initial-[\w-]+\.js$/.test(n));
  if(assetNames.length!==1)throw Error('Unsupported renderer entry layout');
  const moduleUrl='app://-/assets/'+assetNames[0];
  const moduleSha256=crypto.createHash('sha256').update(fs.readFileSync(assetRoot+assetNames[0])).digest('hex');
  const pendingReader=`(async()=>{const resolve=(${clientResolverSource});const c=resolve(await import(${JSON.stringify(moduleUrl)}));return [...c.pendingRequests.keys()];})()`;
  const rendererVerifier=`(async()=>{const resolve=(${clientResolverSource});const c=resolve(await import(${JSON.stringify(moduleUrl)}));return {compatible:true,pendingCount:c.pendingRequests.size};})()`;
  const core = this.fetchWrapper?.options?.chunkedMessageSender?.sender;
  if (!core || typeof core.options?.deliver !== 'function') throw Error('Unsupported delivery interface');
  const verifyDelivery=(0,eval)('('+deliveryVerifierSource+')');
  verifyDelivery(core.options.deliver,core.options);
  const isPrimary=w=>{try{const u=new URL(w.getURL());return !w.isDestroyed()&&w.getType()==='window'&&u.protocol==='app:'&&u.hostname==='-'&&u.pathname==='/index.html';}catch{return false;}};
  const checkWindows=req('electron').webContents.getAllWebContents().filter(isPrimary);
  if(!checkWindows.length)throw Error('Desktop renderer is not ready');
  let verifyTimer;
  try{
    await Promise.race([
      Promise.all(checkWindows.map(w=>w.executeJavaScript(rendererVerifier))),
      new Promise((_,reject)=>{verifyTimer=setTimeout(()=>reject(Error('Renderer compatibility check timed out')),10000);})
    ]);
  }finally{clearTimeout(verifyTimer);}
  const compatibility={mode:'interface-and-behavior',passed:true,moduleSha256,rendererModule:assetNames[0],windowsVerified:checkWindows.length};
  if(settings.probeOnly)return {installed:false,probeOnly:true,pid:process.pid,compatibility};
  const previous=globalThis[Symbol.for('codex.local-response-guard.v1')];
  if(previous)throw Error('Another recovery installation owns a prior hook');
  const original = core.options.deliver;
  const factory = (0,eval)('('+factorySource+')');
  if (!settings.dataRoot || !req('path').isAbsolute(settings.dataRoot)) throw Error('Absolute data directory required');
  const disabledPath = req('path').join(settings.dataRoot, 'codex-response-protection.disabled');
  const statePath = settings.test ? null : req('path').join(settings.dataRoot, 'codex-response-guard-state.json');
  const logPath = settings.test ? null : req('path').join(settings.dataRoot, 'codex-response-guard.log');
  const startedAt = new Date().toISOString();
  let guard, wrapper, expiry, startupTimer;
  const writeState = event => {
    if (!statePath) return;
    try {
      const record = {updatedAt:new Date().toISOString(), installedAt:startedAt, pid:process.pid, version:2, compatibility, ...event};
      fs.writeFileSync(statePath, JSON.stringify(record,null,2));
      if (['installed','replayed','stopped'].includes(event.type)) {
        if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024*1024) fs.renameSync(logPath, logPath+'.previous');
        fs.appendFileSync(logPath, JSON.stringify(record)+'\n');
      }
    } catch {}
  };
  const excludedIds = new Set(settings.test ? req('electron').webContents.getAllWebContents().map(w=>w.id) : []);
  // URL.origin for custom schemes can be "null"; compare the complete trusted prefix instead.
  const trustedWindow = w => {
    try { const u=new URL(w.getURL()); return !excludedIds.has(w.id) && !w.isDestroyed() && w.getType()==='window' && u.protocol==='app:' && u.hostname==='-' && u.pathname==='/index.html'; } catch { return false; }
  };
  guard = factory({
    isEligible:trustedWindow,
    isEnabled:()=>!fs.existsSync(disabledPath),
    pendingIds:w=>w.executeJavaScript(pendingReader),
    redeliver:(w,e,p)=>original.call(core.options,w,e,p),
    watch:(w,invalidate)=>{
      const navigation=(_event,_url,inPlace,mainFrame)=>{if(mainFrame&&!inPlace)invalidate();};
      w.on('did-start-navigation',navigation);w.once('destroyed',invalidate);w.on('render-process-gone',invalidate);
      return ()=>{w.removeListener('did-start-navigation',navigation);w.removeListener('destroyed',invalidate);w.removeListener('render-process-gone',invalidate);};
    },
    onEvent:event=>{writeState(event);if(event.type==='stopped'){if(core.options.deliver===wrapper)core.options.deliver=original;if(globalThis[key]===guard)delete globalThis[key];clearTimeout(expiry);clearTimeout(startupTimer);}}
  });
  wrapper=function(w,envelope,part){guard.capture(w,envelope,part);return original.call(this,w,envelope,part);};
  guard.installationRoot=settings.dataRoot;
  core.options.deliver=wrapper;globalThis[key]=guard;
  if(settings.test){expiry=setTimeout(()=>guard.stop(),60000);expiry.unref();}
  let knownReadHandlers=false;
  // Read retries have separate permissions: keep the previously audited handler allowlist
  // restricted to the known implementation. Reply-only protection needs no request retries.
  try{knownReadHandlers=crypto.createHash('sha256').update(fs.readFileSync(process.resourcesPath+'/app.asar/.vite/build/main-BR_2NHW6.js')).digest('hex')==='1f2b91cf92fc023fb2fa41e1c1d03698fa6e37354ecd07dd0cebd21337607b08';}catch{}
  if(!settings.test&&knownReadHandlers){
    // One startup sweep covers read responses lost before the tray could attach.
    // Only the existing, verified read-only query allowlist can be retried.
    const sweep=`(async()=>{
      const clients=new Set(),seen=new Set(),stack=[];
      for(const el of document.querySelectorAll('#root, #app, body > div'))for(const k of Object.keys(el))if(k.startsWith('__reactContainer$')||k.startsWith('__reactFiber$')){const r=el[k];if(r)stack.push(r.current??r);}
      const add=v=>{if(v&&typeof v.getQueryCache==='function'&&typeof v.cancelQueries==='function'&&typeof v.refetchQueries==='function')clients.add(v);};
      while(stack.length&&seen.size<30000){const f=stack.pop();if(!f||seen.has(f))continue;seen.add(f);if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);if(f.alternate)stack.push(f.alternate);const p=f.memoizedProps;if(p){add(p.client);add(p.value);add(p.value?.query);}}
      if(clients.size!==1)return {reason:'ambiguous-query-client'};
      return (${recoverySource})([...clients][0],{includeStartupReads:true});
    })()`;
    startupTimer=setTimeout(()=>{
      if(!guard.status().active||fs.existsSync(disabledPath))return;
      for(const w of req('electron').webContents.getAllWebContents().filter(trustedWindow)){
        w.executeJavaScript(sweep).then(r=>writeState({type:'startup-read-check',webContentsId:w.id,recovered:r.recovered===true,attempts:r.attempts?.map(a=>({name:a.key?.[1],result:a.result}))??[],...guard.status()})).catch(()=>{});
      }
    },10000);startupTimer.unref();
  }
  writeState({type:'installed',...guard.status()});
  return {installed:true,existing:false,pid:process.pid,compatibility,knownReadHandlers,status:guard.status()};
}
