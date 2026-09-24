// Retry observed stalled local-home reads; opt in to verified read-only startup status endpoints.
// This module never submits a message or changes thread/permission state.
export async function recoverLocalHomeReads(client, options = {}) {
  const settleMs = options.settleMs ?? 15000;
  const retryMs = options.retryMs ?? 12000;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const homeKeys = [ ['vscode', 'codex-home'], ['vscode', 'codex-home', '{"hostId":"local"}'] ];
  const cache = client.getQueryCache();
  const summarize = q => q ? {
    key: q.queryKey, status: q.state.status, fetchStatus: q.state.fetchStatus,
    dataPresent: q.state.data !== undefined, errorPresent: q.state.error != null,
  } : null;
  const isStalled = q => q && q.state.status === 'pending' && q.state.fetchStatus === 'fetching'
    && q.state.data === undefined && q.state.error == null && q.getObserversCount() > 0;
  const startupReadNames = new Set(['get-global-state', 'inbox-items', 'list-automations', 'locale-info', 'global-dictation-hotkey-state']);
  const additional = options.includeStartupReads && typeof cache.getAll === 'function'
    ? cache.getAll().filter(q => Array.isArray(q.queryKey) && q.queryKey[0] === 'vscode'
      && startupReadNames.has(q.queryKey[1]) && isStalled(q)).slice(0, 12) : [];
  const keys = [...homeKeys, ...additional.map(q => q.queryKey)];
  const candidates = keys.map(key => cache.find({ queryKey: key, exact: true })).filter(isStalled);
  const before = keys.map(key => summarize(cache.find({ queryKey: key, exact: true })));
  if (!candidates.length) return { recovered: false, reason: 'no-stalled-local-home-query', before, attempts: [] };
  await sleep(settleMs);
  const stable = candidates.filter(q => cache.find({ queryKey: q.queryKey, exact: true }) === q && isStalled(q));
  if (!stable.length) return { recovered: false, reason: 'reads-resolved-or-retired-during-observation', before, attempts: [] };
  const attempts = await Promise.all(stable.map(async q => {
    const filter = { queryKey: q.queryKey, exact: true };
    await client.cancelQueries(filter, { silent: true });
    // The original object must still own the key after cancellation.
    if (cache.find(filter) !== q) return { key: q.queryKey, result: 'retired' };
    let timer;
    try {
      await Promise.race([
        client.refetchQueries({ ...filter, type: 'all' }, { throwOnError: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Read retry timed out')), retryMs); }),
      ]);
      return { key: q.queryKey, result: q.state.status === 'success' && q.state.data !== undefined ? 'success' : 'not-ready' };
    } catch (error) {
      await client.cancelQueries(filter, { silent: true });
      return { key: q.queryKey, result: 'failed', error: error instanceof Error ? error.message : String(error) };
    } finally { clearTimeout(timer); }
  }));
  const after = keys.map(key => summarize(cache.find({ queryKey: key, exact: true })));
  const homeAfter = after.slice(0, homeKeys.length);
  return { recovered: attempts.some(a => a.result === 'success') && homeAfter.every(q => !q || (q.status === 'success' && q.dataPresent && !q.errorPresent)), before, after, attempts };
}
