import crypto from 'node:crypto';
import { config } from '../config.js';

export function parseProxy(rawUrl = config.proxyUrl) {
  const url = (rawUrl || '').trim();
  if (!url) return null;

  const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`PROXY_URL invalida: "${rawUrl}"`);
  }

  return {
    protocol: (parsed.protocol || 'http:').replace(':', ''),
    host: parsed.hostname,
    port: parseInt(parsed.port, 10) || 8080,
    username: decodeURIComponent(parsed.username || ''),
    password: decodeURIComponent(parsed.password || ''),
  };
}

export function makeSessionId(seed) {
  const base = seed !== undefined ? String(seed) : crypto.randomBytes(4).toString('hex');
  const hash = crypto.createHash('md5').update(`${base}:${Date.now()}:${crypto.randomBytes(2).toString('hex')}`).digest('hex');
  // Lightning aceita session numerica (6 digitos) — IP unico por sessao.
  return String(parseInt(hash.slice(0, 8), 16) % 1_000_000).padStart(6, '0');
}

/**
 * Monta username sticky com sessao unica (Lightning: {user}-session-{id}).
 */
export function buildStickyUsername(baseUsername, sessionId) {
  const tpl = (config.proxySessionTemplate || '{user}-session-{session}').trim();
  if (tpl.includes('{user}') || tpl.includes('{session}')) {
    return tpl.replace('{user}', baseUsername).replace('{session}', sessionId);
  }
  return `${baseUsername}-session-${sessionId}`;
}

export function getInstanceProxy({ seed } = {}) {
  const base = parseProxy();
  if (!base) return null;

  if (!config.proxySticky || !base.username) {
    return { ...base, sessionId: null };
  }

  const sessionId = makeSessionId(seed);
  const username = buildStickyUsername(base.username, sessionId);

  return { ...base, username, sessionId };
}

export function proxyServerArg(proxy) {
  if (!proxy) return null;
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
}

export function maskProxy(proxy) {
  if (!proxy) return '(sem proxy)';
  const user = proxy.username ? proxy.username : '';
  return `${proxy.protocol}://${user ? `${user}:***@` : ''}${proxy.host}:${proxy.port}`;
}

const PROXY_VERIFY_URLS = [
  'https://ip-check.lightningproxies.net',
  'https://api.ipify.org?format=json',
  'https://api64.ipify.org?format=json',
];

function formatProxyError(msg = '') {
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(msg)) {
    return 'proxy sem tunel HTTPS (Lightning: recarregue creditos — HTTP 402 = saldo esgotado)';
  }
  if (/Navigation timeout|ERR_TIMED_OUT/i.test(msg)) {
    return `proxy lenta ou sobrecarregada (${msg.slice(0, 80)})`;
  }
  if (/ERR_PROXY|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i.test(msg)) {
    return `proxy inalcancavel: ${msg.slice(0, 100)}`;
  }
  return msg.slice(0, 120);
}

/** Erro de rede/proxy/browser — instancia deve fechar e liberar slot. */
export function isConnectionError(message) {
  const t = String(message || '').toLowerCase();
  return (
    /err_tunnel|err_connection|err_proxy|err_timed_out|err_empty_response|err_network|err_internet_disconnected|err_name_not_resolved|net::err/i.test(
      t,
    ) ||
    /navigation timeout|connection (closed|reset|lost|refused|failed)|econnreset|etimedout|socket hang up/i.test(
      t,
    ) ||
    /target closed|session closed|protocol error|browser has disconnected|browser disconnected/i.test(
      t,
    ) ||
    /erro de conex[aã]o|n[aã]o foi poss[ií]vel conectar|failed to fetch|proxy inalcancavel|proxy sem tunel/i.test(
      t,
    )
  );
}

export async function isBrowserConnected(browser) {
  if (!browser) return false;
  try {
    if (typeof browser.isConnected === 'function' && !browser.isConnected()) return false;
    await browser.version();
    return true;
  } catch {
    return false;
  }
}

async function tryProxyUrl(page, url, timeout) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  const status = res?.status?.() ?? 0;
  if (status > 0 && status < 500) return { ok: true, status, url };
  return { ok: false, status, reason: `proxy respondeu HTTP ${status} em ${url}` };
}

/**
 * Verifica tunel HTTPS da proxy (leve — nao usa grok.com para nao estourar timeout no cold start).
 * HTTP 402 na Lightning = sem credito -> HTTPS falha com ERR_TUNNEL_CONNECTION_FAILED.
 */
export async function verifyProxyHttps(
  page,
  { timeout = config.proxyVerifyTimeoutMs, testUrls = PROXY_VERIFY_URLS } = {},
) {
  const urls = (testUrls?.length ? testUrls : PROXY_VERIFY_URLS).filter(Boolean);
  let lastReason = 'proxy nao respondeu';

  for (const url of urls) {
    try {
      const result = await tryProxyUrl(page, url, timeout);
      if (result.ok) return result;
      lastReason = result.reason || lastReason;
    } catch (err) {
      lastReason = formatProxyError(err.message || String(err));
      if (/timeout|ERR_/i.test(lastReason)) continue;
      return { ok: false, reason: lastReason };
    }
  }

  return { ok: false, reason: lastReason };
}

/** Retry da verificacao de proxy (cold start do Chrome + concorrencia alta). */
export async function verifyProxyWithRetry(page, log, { retries = config.proxyVerifyRetries } = {}) {
  const max = Math.max(1, retries);
  let last = { ok: false, reason: 'proxy nao verificada' };

  for (let attempt = 1; attempt <= max; attempt++) {
    last = await verifyProxyHttps(page);
    if (last.ok) return last;

    const retryable = /lenta|timeout|sobrecarregada|ERR_/i.test(last.reason || '');
    if (!retryable || attempt >= max) break;

    log?.warn?.(`Proxy verify ${attempt}/${max} falhou: ${last.reason}`);
    await new Promise((r) => setTimeout(r, 1200 * attempt));
  }

  return last;
}

/** Consulta IP publico visto pelo browser (via proxy se configurada). */
export async function probePublicIp(page, { timeout = 12000 } = {}) {
  const endpoints = [
    'https://api.ipify.org?format=json',
    'https://api64.ipify.org?format=json',
    'https://ip-check.lightningproxies.net',
    'http://ip-api.com/json/?fields=query',
  ];

  let lastErr;
  for (const url of endpoints) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      try {
        const data = JSON.parse(body);
        const ip = String(data.ip || data.query || data.origin || '').trim();
        if (ip) return ip;
      } catch {
        const m = body.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
        if (m) return m[0];
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('nao foi possivel obter IP publico');
}

export function isProxyActive() {
  return !!(config.proxyUrl && config.loginUseProxy);
}

export function effectiveNavTimeout() {
  return isProxyActive() ? config.proxyNavTimeoutMs : config.navTimeout;
}

export function effectiveLoginPostSubmitMs() {
  return isProxyActive() ? config.proxyLoginPostSubmitMs : config.loginPostSubmitMs;
}

/** Poll mais frequente no login com proxy (detecta redirect antes). */
export function effectiveLoginPollMs() {
  if (!isProxyActive()) return config.loginPollMs;
  const cap = config.proxyLoginPollMs || 100;
  return Math.min(config.loginPollMs, cap);
}

/** Timeout de selectors do formulario (nao usar NAV_TIMEOUT inteiro em cada campo). */
export function effectiveLoginSelectorTimeout(fallback = 12000) {
  if (!isProxyActive()) return fallback;
  return Math.min(fallback, config.proxyLoginSelectorTimeoutMs || 10000);
}

/** Checagem trial mais curta apos login com proxy. */
export function effectiveTrialCheckMs(quickCheck = false) {
  if (!quickCheck) return Math.max(config.trialCheckMs, 10000);
  if (!isProxyActive()) return config.trialCheckMs;
  const cap = config.proxyTrialCheckMs || 8000;
  return Math.min(config.trialCheckMs, cap);
}

export function effectiveInstanceStaggerMs() {
  if (!isProxyActive()) return config.instanceStaggerMs;
  return Math.max(config.instanceStaggerMs, config.proxyInstanceStaggerMs);
}

export function effectiveConcurrencyLimit(requested, accountCount) {
  let limit = Math.max(1, Math.min(requested, accountCount));
  if (isProxyActive() && config.proxyMaxConcurrency > 0) {
    limit = Math.min(limit, config.proxyMaxConcurrency);
  }
  return limit;
}
