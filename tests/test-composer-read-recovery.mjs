import assert from 'node:assert/strict';
import { recoverLocalHomeReads } from '../composer-read-recovery.mjs';
const allowed = [['vscode','codex-home'],['vscode','codex-home','{"hostId":"local"}']];
const makeQuery = (key, state = 'pending', observers = 1) => ({
  queryKey: key, getObserversCount: () => observers,
  state: {status: state, fetchStatus: state === 'pending' ? 'fetching' : 'idle', data: state === 'success' ? {} : undefined, error: null},
});
function fixture(queries, fail = false) {
  const calls = [];
  const find = f => queries.find(q => JSON.stringify(q.queryKey) === JSON.stringify(f.queryKey));
  return { calls, getQueryCache: () => ({find}),
    async cancelQueries(filter) {assert.equal(filter.exact,true);calls.push(['cancel',filter.queryKey]);find(filter).state.fetchStatus='idle';},
    async refetchQueries(filter) {assert.equal(filter.exact,true);assert.equal(filter.type,'all');assert(allowed.some(k=>JSON.stringify(k)===JSON.stringify(filter.queryKey)));calls.push(['refetch',filter.queryKey]);if(fail)throw new Error('simulated missing configuration');Object.assign(find(filter).state,{status:'success',fetchStatus:'idle',data:{},error:null});},
  };
}
const noDelay = {sleep: async () => {}};
{
  const c=fixture(allowed.map(k=>makeQuery(k,'success')));
  assert.equal((await recoverLocalHomeReads(c,noDelay)).recovered,false);assert.equal(c.calls.length,0);
}
{
  const write=makeQuery(['vscode','turn/start']);
  const c=fixture([...allowed.map(k=>makeQuery(k)),write]);
  const r=await recoverLocalHomeReads(c,noDelay);assert.equal(r.recovered,true);assert.equal(c.calls.filter(x=>x[0]==='refetch').length,2);assert.equal(write.state.status,'pending');
}
{
  const q=makeQuery(allowed[0]);const c=fixture([q]);
  const r=await recoverLocalHomeReads(c,{sleep:async()=>Object.assign(q.state,{status:'success',fetchStatus:'idle',data:{}})});
  assert.equal(r.recovered,false);assert.equal(c.calls.length,0);
}
{
  const c=fixture([makeQuery(allowed[0],'pending',0)]);
  assert.equal((await recoverLocalHomeReads(c,noDelay)).recovered,false);assert.equal(c.calls.length,0);
}
{
  const c=fixture([makeQuery(allowed[0])],true);
  const r=await recoverLocalHomeReads(c,noDelay);assert.equal(r.recovered,false);assert.equal(r.attempts[0].result,'failed');assert.equal(c.calls.filter(x=>x[0]==='refetch').length,1);
}
{
  const q=makeQuery(allowed[0]);const c=fixture([q]);
  c.refetchQueries=async filter=>{c.calls.push(['refetch',filter.queryKey]);await new Promise(()=>{});};
  const r=await recoverLocalHomeReads(c,{...noDelay,retryMs:20});
  assert.equal(r.recovered,false);assert.equal(r.attempts[0].error,'Read retry timed out');assert.equal(c.calls.filter(x=>x[0]==='refetch').length,1);assert.equal(c.calls.filter(x=>x[0]==='cancel').length,2);
}
{
  const q=makeQuery(allowed[0]);const queries=[q];const c=fixture(queries);
  const r=await recoverLocalHomeReads(c,{sleep:async()=>{queries[0]=makeQuery(allowed[0]);}});
  assert.equal(r.recovered,false);assert.equal(c.calls.length,0);
}
console.log('PASS: healthy reads untouched; only two allowlisted reads retried; completed/inactive queries untouched; failed retries bounded; message submission untouched.');
