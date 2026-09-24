import { verifyDesktopTarget } from './codex-target.mjs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import {installResponseGuard} from './codex-install-response-guard.mjs';

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
    result.protection = await installResponseGuard(command, {dataRoot:fileURLToPath(new URL('.', import.meta.url)),remove:process.argv.includes('--remove'),probeOnly:process.argv.includes('--compatibility-check')});
  }

  if (outArg) await writeFile(outArg.slice(6), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));

} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = /Unsupported/.test(error.message) ? 3 : 1;
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
  const listenerClosed = !await portOpen();
  console.log(JSON.stringify({ diagnosticListenerClosed: listenerClosed }));
  if (owned && !listenerClosed) process.exitCode = 1;
  if (child) child.kill();
}
