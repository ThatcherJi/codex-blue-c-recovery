// Delivery-only recovery. Never invokes a request handler or writes response bodies to disk.
export function createResponseGuard(options) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const cancel = options.cancel ?? clearTimeout;
  const delay = options.delay ?? 2500;
  const ttl = options.ttl ?? 45000;
  const maxEntries = options.maxEntries ?? 128;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
  const entries = new Map();
  const windows = new Map();
  const counts = { captured: 0, replayed: 0, acknowledged: 0, expired: 0, evicted: 0, skipped: 0, checkErrors: 0 };
  let bytes = 0, stopped = false, timer = null;
  const notify = type => { try { options.onEvent?.({ type, at: now(), ...status() }); } catch {} };
  function status() { return { active: !stopped, queued: entries.size, bytes, windows: windows.size, counts: { ...counts } }; }
  function drop(key, reason) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key); bytes -= entry.bytes;
    if (reason && reason in counts) counts[reason]++;
  }
  function forgetWindow(target) {
    for (const [key, entry] of entries) if (entry.target === target) drop(key, 'expired');
    const state = windows.get(target);
    if (state) { windows.delete(target); try { state.cleanup?.(); } catch {} }
  }
  function arm() {
    if (!stopped && !timer && entries.size) timer = schedule(() => { timer = null; tick().catch(() => { counts.checkErrors++; arm(); }); }, Math.min(delay, 1000));
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) cancel(timer);
    timer = null; entries.clear(); bytes = 0;
    for (const target of [...windows.keys()]) forgetWindow(target);
    notify('stopped');
  }
  function capture(target, envelope, part) {
    if (stopped) return;
    try {
      if (options.isEnabled && !options.isEnabled()) { stop(); return; }
      const response = part ?? envelope?.payload;
      if (envelope?.channel !== 'codex_desktop:message-for-view' || response?.type !== 'fetch-response' ||
          typeof response.requestId !== 'string' || response.requestId.length > 200 || !options.isEligible(target)) return;
      // Chunk envelopes and streamed updates are deliberately not transformed.
      if (!['success', 'error'].includes(response.responseType)) return;
      const size = JSON.stringify(response).length * 2;
      if (size > maxResponseBytes) { counts.skipped++; return; }
      const key = `${target.id}:${response.requestId}`;
      if (entries.has(key)) return;
      while (entries.size && (entries.size >= maxEntries || bytes + size > maxBytes)) drop(entries.keys().next().value, 'evicted');
      if (size > maxBytes || maxEntries < 1) { counts.skipped++; return; }
      let state = windows.get(target);
      if (!state) {
        state = { checking: false, generation: 0, cleanup: null };
        windows.set(target, state);
        state.cleanup = options.watch?.(target, () => { state.generation++; forgetWindow(target); });
      }
      entries.set(key, { target, envelope, part, id: response.requestId, bytes: size, created: now(), due: now() + delay, attempts: 0, state, generation: state.generation });
      bytes += size; counts.captured++; arm();
    } catch { counts.checkErrors++; }
  }
  async function tick() {
    if (stopped) return;
    if (options.isEnabled && !options.isEnabled()) { stop(); return; }
    for (const [key, entry] of entries) if (now() - entry.created >= ttl || !options.isEligible(entry.target)) drop(key, 'expired');
    const dueTargets = new Set([...entries.values()].filter(e => e.due <= now()).map(e => e.target));
    for (const target of dueTargets) {
      const state = windows.get(target);
      if (!state || state.checking) continue;
      state.checking = true;
      const generation = state.generation;
      // Do not block other windows on an unresponsive renderer; allow only one inspection per window.
      Promise.resolve().then(() => options.pendingIds(target)).then(ids => {
        if (stopped || windows.get(target) !== state || generation !== state.generation || !options.isEligible(target)) return;
        if (options.isEnabled && !options.isEnabled()) { stop(); return; }
        if (!(ids instanceof Set) && !Array.isArray(ids)) throw Error('Pending request map is unavailable');
        const pending = ids instanceof Set ? ids : new Set(ids);
        let replayed = 0;
        for (const [key, entry] of entries) {
          if (entry.target !== target || entry.due > now()) continue;
          if (now() - entry.created >= ttl) { drop(key, 'expired'); continue; }
          if (!pending.has(entry.id)) { drop(key, 'acknowledged'); continue; }
          if (entry.attempts >= 4) { drop(key, 'expired'); continue; }
          // Reuse the original reply and ID, never the request that produced it.
          options.redeliver(entry.target, entry.envelope, entry.part);
          entry.attempts++; counts.replayed++; replayed++;
          entry.due = now() + delay * Math.pow(2, entry.attempts);
        }
        if (replayed) notify('replayed');
        else if (!entries.size) notify('settled');
      }).catch(() => { counts.checkErrors++; for (const e of entries.values()) if (e.target === target) e.due = now() + delay; })
        .finally(() => { state.checking = false; arm(); });
    }
    for (const target of [...windows.keys()]) if (![...entries.values()].some(e => e.target === target)) forgetWindow(target);
    arm();
  }
  return { capture, tick, stop, status, forgetWindow };
}
