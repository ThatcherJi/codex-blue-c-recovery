import assert from 'node:assert/strict';
import { recoverLocalHomeReads } from '../composer-read-recovery.mjs';
const names=['get-global-state','inbox-items','list-automations','locale-info','global-dictation-hotkey-state'];
const query=(name,healthy=false)=>({queryKey:['vscode',name],getObserversCount:()=>1,state:{status:healthy?'success':'pending',fetchStatus:healthy?'idle':'fetching',data:healthy?{}:undefined,error:null}});
function fixture(rows){
  const calls=[];const find=f=>rows.find(q=>JSON.stringify(q.queryKey)===JSON.stringify(f.queryKey));
  return {calls,getQueryCache:()=>({find,getAll:()=>rows}),cancelQueries:async f=>{assert.equal(f.exact,true);calls.push(['cancel',f.queryKey[1]]);find(f).state.fetchStatus='idle';},refetchQueries:async f=>{assert(names.includes(f.queryKey[1]));calls.push(['retry',f.queryKey[1]]);Object.assign(find(f).state,{status:'success',fetchStatus:'idle',data:{}});}};
}
const opts={includeStartupReads:true,sleep:async()=>{}};
{
  const rows=[query('codex-home',true),...names.map(n=>query(n)),query('set-global-state'),query('set-remote-control-connections-enabled'),query('turn/start'),query('codex-command-keymap-state')];
  const c=fixture(rows),result=await recoverLocalHomeReads(c,opts);
  assert.equal(result.recovered,true);assert.equal(result.attempts.length,5);
  for(const row of rows.slice(-4))assert.equal(row.state.status,'pending');
}
{
  const c=fixture([query('codex-home',true),query('locale-info')]);
  const result=await recoverLocalHomeReads(c,{sleep:async()=>{}});assert.equal(result.attempts.length,0);assert.equal(c.calls.length,0);
}
{
  const inactive=query('locale-info');inactive.getObserversCount=()=>0;
  const c=fixture([query('codex-home',true),inactive,...names.map(n=>query(n,true))]);
  const result=await recoverLocalHomeReads(c,opts);assert.equal(result.attempts.length,0);assert.equal(c.calls.length,0);
}
{
  const c=fixture([query('codex-home',true),query('inbox-items'),query('locale-info')]);
  const original=c.refetchQueries;c.refetchQueries=async f=>{if(f.queryKey[1]==='locale-info')throw Error('simulated read failure');return original(f);};
  const result=await recoverLocalHomeReads(c,opts);assert.equal(result.recovered,true);assert.equal(result.attempts.filter(x=>x.result==='failed').length,1);
}
console.log('PASS: startup reads require opt-in; only five verified read endpoints retried; write/turn/keymap migrations untouched; inactive/healthy reads untouched; auxiliary failure does not restart a healthy composer.');
