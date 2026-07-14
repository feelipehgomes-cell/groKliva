/** Sessoes de subscribe em andamento (visivel no terminal e no Ctrl+C). */
const active = new Map();

export function subscribeActivityStart(email, { workerId = '', phase = 'subscribe' } = {}) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return;
  active.set(key, {
    email: String(email).trim(),
    workerId,
    phase,
    subscribeAttempts: 0,
    subscribeGrokErrors: 0,
    startedAt: Date.now(),
    lastUpdateAt: Date.now(),
  });
}

export function subscribeActivityUpdate(email, partial = {}) {
  const key = String(email || '').trim().toLowerCase();
  const cur = active.get(key);
  if (!cur) return;
  active.set(key, {
    ...cur,
    ...partial,
    lastUpdateAt: Date.now(),
  });
}

export function subscribeActivityEnd(email) {
  const key = String(email || '').trim().toLowerCase();
  active.delete(key);
}

export function getActiveSubscribeSessions() {
  return [...active.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function formatActiveSubscribeLines(sessions = getActiveSubscribeSessions()) {
  if (!sessions.length) return [];
  const lines = [`subscribe em andamento: ${sessions.length} instancia(s)`];
  const now = Date.now();
  for (const s of sessions) {
    const sec = Math.round((now - s.startedAt) / 1000);
    const idleSec = Math.round((now - (s.lastUpdateAt || s.startedAt)) / 1000);
    const stale = idleSec >= 480 ? ' | PRESO?' : '';
    lines.push(
      `  ${s.email} | ${s.workerId || '?'} | ${s.phase} | cliques: ${s.subscribeAttempts ?? 0} | erros Grok: ${s.subscribeGrokErrors ?? 0} | ${sec}s${stale}`,
    );
  }
  return lines;
}
