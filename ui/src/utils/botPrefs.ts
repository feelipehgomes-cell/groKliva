import { api } from '../api/client';

const KEYS = {
  activate: 'kliva-activate-opts',
  generate: 'kliva-generate-opts',
} as const;

export type ActivateOpts = { limit: number; concurrency: number };
export type GenerateOpts = { count: number; concurrency: number };

const DEFAULTS = {
  activate: { limit: 0, concurrency: 1 } satisfies ActivateOpts,
  generate: { count: 1, concurrency: 1 } satisfies GenerateOpts,
};

function load<T>(key: string, defaults: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function save<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const botPrefs = {
  loadActivate: () => load(KEYS.activate, DEFAULTS.activate),
  saveActivate: (opts: ActivateOpts) => save(KEYS.activate, opts),
  loadGenerate: () => load(KEYS.generate, DEFAULTS.generate),
  saveGenerate: (opts: GenerateOpts) => save(KEYS.generate, opts),
};

export async function persistConcurrency(concurrency: number) {
  await api.saveSettings({ CONCURRENCY: String(concurrency) });
}

export async function persistActivateLimit(limit: number) {
  const n = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 0;
  await api.saveSettings({ ACTIVATE_ACCOUNT_LIMIT: String(n) });
}

export async function persistActivateOpts(opts: ActivateOpts) {
  await api.saveSettings({
    CONCURRENCY: String(opts.concurrency),
    ACTIVATE_ACCOUNT_LIMIT: String(
      Number.isFinite(opts.limit) && opts.limit >= 0 ? Math.floor(opts.limit) : 0,
    ),
  });
}
