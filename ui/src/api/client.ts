async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  dashboard: () => request<any>('/api/dashboard'),
  botStatus: () => request<any>('/api/bots/status'),
  startActivate: (body: object) =>
    request<any>('/api/bots/activate/start', { method: 'POST', body: JSON.stringify(body) }),
  stopActivate: (groupId: string) =>
    request<any>('/api/bots/activate/stop', {
      method: 'POST',
      body: JSON.stringify({ groupId }),
    }),
  groups: () => request<any>('/api/groups'),
  discoverGroups: () => request<any>('/api/groups/discover'),
  addGroup: (body: { id: string; label: string }) =>
    request<any>('/api/groups', { method: 'POST', body: JSON.stringify(body) }),
  deleteGroup: (id: string) =>
    request<any>(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setGroupEnabled: (id: string, enabled: boolean) =>
    request<any>(`/api/groups/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  setGroupSendReadyPix: (id: string, sendReadyPix: boolean) =>
    request<any>(`/api/groups/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sendReadyPix }),
    }),
  resetGroupStats: (id: string) =>
    request<any>(`/api/groups/${encodeURIComponent(id)}/stats/reset`, { method: 'POST' }),
  accounts: () => request<any>('/api/accounts'),
  addAccountsText: (text: string) =>
    request<any>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  deleteAccount: (email: string) =>
    request<any[]>(`/api/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  cpfs: () => request<any>('/api/cpfs'),
  addCpfsText: (text: string) =>
    request<any>('/api/cpfs', { method: 'POST', body: JSON.stringify({ text }) }),
  deleteCpf: (cpf: string) =>
    request<any>(`/api/cpfs/${encodeURIComponent(cpf)}`, { method: 'DELETE' }),
  settings: () => request<any>('/api/settings'),
  saveSettings: (body: object) =>
    request<any>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  whatsappStatus: () => request<any>('/api/whatsapp/status'),
  whatsappLoginStart: (force = false) =>
    request<any>('/api/whatsapp/login/start', {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  whatsappLoginCancel: () =>
    request<any>('/api/whatsapp/login/cancel', { method: 'POST', body: '{}' }),
  whatsappDisconnect: () =>
    request<any>('/api/whatsapp/disconnect', { method: 'POST', body: '{}' }),
  whatsappHubReconnect: () =>
    request<any>('/api/whatsapp/hub/reconnect', { method: 'POST', body: '{}' }),
  releaseReadyAccounts: (
    kind: 'activate',
    count: number | 'all',
    groupId?: string,
  ) =>
    request<{ ok: boolean; text: string; copied: number; remaining: number }>(
      '/api/dashboard/release-accounts',
      { method: 'POST', body: JSON.stringify({ kind, count, groupId }) },
    ),
};

export function connectBotLogs(
  name: string,
  onLine: (entry: any) => void,
  groupId?: string,
) {
  const url =
    name === 'activate' && groupId
      ? `/api/bots/activate/${encodeURIComponent(groupId)}/logs`
      : `/api/bots/${name}/logs`;
  const es = new EventSource(url);
  es.onmessage = (ev) => {
    try {
      onLine(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}
