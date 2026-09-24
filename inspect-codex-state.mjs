import { verifyDesktopTarget } from './codex-target.mjs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { recoverLocalHomeReads } from './composer-read-recovery.mjs';

const probe = process.argv.includes('--probe');
const repair = process.argv.includes('--repair');
const pidArg = process.argv.find(x => x.startsWith('--pid='));
const outArg = process.argv.find(x => x.startsWith('--out='));
let child;
let socket;
let owned = false;
let verified = false;
const leaseToken = randomUUID();
let seq = 0;
const waiting = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function portOpen() {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: 9229 });
    const done = result => { s.destroy(); resolve(result); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(500, () => done(true));
  });
}
async function command(method, params = {}, timeout = 10000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeout);
    waiting.set(id, { resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}
const readRenderer = `(() => {
  const roots = [];
  const clients = new Set();
  const composers = [];
  const safeProps = ['hasMessageContent','isThreadHistoryLoading','isResponseInProgress','isResumePending','submitDisabled','isInteractionBlocked','localWorkspaceMaterialization','submitBlockReason','isSubmitButtonLoading','isSubmitting'];
  for (const element of document.querySelectorAll('#root, #app, body > div')) {
    for (const key of Object.keys(element)) {
      if (key.startsWith('__reactContainer$') || key.startsWith('__reactFiber$')) {
        const root = element[key];
        if (root) roots.push(root.current ?? root);
      }
    }
    const oldRoot = element._reactRootContainer?._internalRoot?.current;
    if (oldRoot) roots.push(oldRoot);
  }
  const visited = new Set();
  const stack = [...roots];
  const addClient = value => {
    if (value && typeof value.getQueryCache === 'function' && typeof value.cancelQueries === 'function' && typeof value.refetchQueries === 'function') clients.add(value);
  };
  while (stack.length && visited.size < 30000) {
    const fiber = stack.pop();
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);
    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.alternate) stack.push(fiber.alternate);
    const p = fiber.memoizedProps;
    if (!p || typeof p !== 'object') continue;
    addClient(p.client); addClient(p.value); addClient(p.value?.query);
    if ('submitDisabled' in p || 'submitBlockReason' in p) {
      const info = {};
      for (const key of safeProps) {
        const value = p[key];
        if (value === null || ['boolean','number','string'].includes(typeof value)) info[key] = value;
      }
      if (Object.keys(info).length && composers.length < 32) composers.push(info);
    }
  }
  const queryStates = [];
  for (const client of clients) {
    for (const q of client.getQueryCache().getAll()) {
      if (!Array.isArray(q.queryKey) || q.queryKey[0] !== 'vscode' || q.queryKey[1] !== 'codex-home') continue;
      queryStates.push({ key: q.queryKey, status: q.state.status, fetchStatus: q.state.fetchStatus, dataPresent: q.state.data !== undefined, errorPresent: q.state.error != null, dataUpdatedAt: q.state.dataUpdatedAt, fetchFailureCount: q.state.fetchFailureCount });
    }
  }
  const result = { roots: roots.length, fibersVisited: visited.size, clientCount: clients.size, queryStates, composers };
  ${repair ? `
  if (clients.size !== 1) return {...result, recovery: {recovered:false, reason:'ambiguous-query-client'}};
  return (${recoverLocalHomeReads.toString()})([...clients][0], {includeStartupReads:true}).then(recovery => ({...result, recovery}));
  ` : 'return result;'}
})()`;

try {
  if (await portOpen()) throw new Error('An existing diagnostic listener is present; refusing to take it over.');
  let expectedPid;
  if (probe) {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    expectedPid = child.pid;
    await pause(400);
  } else {
    expectedPid = Number(pidArg?.split('=')[1]);
    if (!Number.isInteger(expectedPid) || expectedPid <= 0) throw new Error('A verified target PID is required.');
  }
  if (!probe) await verifyDesktopTarget(expectedPid);
  process._debugProcess(expectedPid);
  owned = true;
  let targets;
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(500) });
      targets = await response.json();
      break;
    } catch { await pause(150); }
  }
  if (!Array.isArray(targets) || targets.length !== 1) throw new Error('Expected exactly one Node diagnostic target.');
  const url = new URL(targets[0].webSocketDebuggerUrl);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.port !== '9229') throw new Error('Non-loopback diagnostic target refused.');
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Diagnostic connection timed out')), 4000);
    socket.addEventListener('open', () => {clearTimeout(timer);resolve();}, { once: true });
    socket.addEventListener('error', error => {clearTimeout(timer);reject(error);}, { once: true });
  });
  socket.addEventListener('message', e => {
    const message = JSON.parse(e.data);
    const request = waiting.get(message.id);
    if (!request) return;
    waiting.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  const identity = await evaluate('({pid:process.pid,type:process.type??null,electron:process.versions.electron??null,node:process.versions.node})');
  if (identity.pid !== expectedPid) throw new Error('Diagnostic PID did not match the verified target.');
  verified = true;
  await evaluate(`(() => {
    const inspector=process.getBuiltinModule('inspector');
    const key=Symbol.for('codex.local-diagnostic-lease');
    const lease={token:${JSON.stringify(leaseToken)},url:inspector.url(),inspector,timer:null};
    if(globalThis[key])throw new Error('A prior diagnostic lease still exists');
    globalThis[key]=lease;
    lease.timer=setTimeout(()=>{if(globalThis[key]!==lease)return;delete globalThis[key];try{if(inspector.url()===lease.url)inspector.close()}catch{}},45000);
    lease.timer.unref();return true;
  })()`);
  if (!probe && (identity.type !== 'browser' || !identity.electron)) throw new Error('Target is not the Electron main process.');
  let result = { capturedAt: new Date().toISOString(), identity, probe };
  if (!probe) {
    if (repair) {
      const audited = await evaluate(`(() => {const r=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json');try{return r('crypto').createHash('sha256').update(r('fs').readFileSync(process.resourcesPath+'/app.asar/.vite/build/main-BR_2NHW6.js')).digest('hex')==='1f2b91cf92fc023fb2fa41e1c1d03698fa6e37354ecd07dd0cebd21337607b08';}catch{return false;}})()`);
      if (!audited) throw Error('Unsupported read-retry implementation; no requests retried');
    }
    const expression = `(() => {
      const requireLocal = process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json');
      const electron = requireLocal('electron');
      const windows = electron.webContents.getAllWebContents().filter(w => w.getType() === 'window' && w.getURL() === 'app://-/index.html' && electron.BrowserWindow.fromWebContents(w)?.isVisible());
      if (windows.length !== 1) throw new Error('Ambiguous main application window: ' + windows.length);
      return windows[0].executeJavaScript(${JSON.stringify(readRenderer)}).then(state => ({webContentsId:windows[0].id,state}));
    })()`;
    if (repair) {
      const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 35000);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      result.renderer = response.result?.value;
    } else result.renderer = await evaluate(expression);
  }
  if (outArg) await writeFile(outArg.slice(6), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  if (repair && !result.renderer?.state?.recovery?.recovered) process.exitCode = 2;
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  if (socket?.readyState === WebSocket.OPEN && owned && verified) {
    try { await evaluate(`(() => {
      const key=Symbol.for('codex.local-diagnostic-lease');const lease=globalThis[key];
      if(lease?.token!==${JSON.stringify(leaseToken)})return false;
      clearTimeout(lease.timer);delete globalThis[key];
      setTimeout(()=>{try{if(lease.inspector.url()===lease.url)lease.inspector.close()}catch{}},150).unref();return true;
    })()`); } catch (error) { console.error('Cleanup request failed:', error.message); }
    socket.close();
  }
  else if (socket) socket.close();
  for (let i = 0; i < 20 && await portOpen(); i++) await pause(150);
  console.log(JSON.stringify({ diagnosticListenerClosed: !await portOpen() }));
  if (child) child.kill();
}
