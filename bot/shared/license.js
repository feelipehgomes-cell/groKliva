import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR } from './config.js';

const CACHE_FILE = path.join(ROOT_DIR, 'data', '.license-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EMBEDDED_SECRET = process.env.__KLIVA_LICENSE_SECRET__ || '';

export function getMachineId() {
  const raw = [
    os.hostname(),
    os.userInfo().username,
    os.platform(),
    os.arch(),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data?.validUntil || Date.now() > data.validUntil) return null;
    if (data.key !== process.env.KLIVA_LICENSE_KEY?.trim()) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(key, expiresAt) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({
        key,
        expiresAt,
        validUntil: Date.now() + CACHE_TTL_MS,
      }),
      'utf8',
    );
  } catch {
    /* noop */
  }
}

function parseLicenseKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed.startsWith('KLIVA.')) return null;
  const parts = trimmed.split('.');
  if (parts.length !== 3) return null;
  const [, payloadB64, sig] = parts;
  try {
    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    return { payload, payloadB64, sig };
  } catch {
    return null;
  }
}

function verifyOfflineLicense(key, { machineId } = {}) {
  if (!EMBEDDED_SECRET) {
    return { ok: false, reason: 'Licenca offline nao configurada neste build.' };
  }

  const parsed = parseLicenseKey(key);
  if (!parsed) {
    return { ok: false, reason: 'Formato de licenca invalido.' };
  }

  const expected = crypto
    .createHmac('sha256', EMBEDDED_SECRET)
    .update(parsed.payloadB64)
    .digest('base64url');

  if (expected !== parsed.sig) {
    return { ok: false, reason: 'Assinatura da licenca invalida.' };
  }

  const { payload } = parsed;
  if (payload.v !== 1) {
    return { ok: false, reason: 'Versao de licenca nao suportada.' };
  }

  if (payload.exp && Date.now() > payload.exp) {
    return { ok: false, reason: 'Licenca expirada.' };
  }

  if (payload.mid && machineId && payload.mid !== machineId) {
    return { ok: false, reason: 'Licenca vinculada a outra instalacao.' };
  }

  return {
    ok: true,
    email: payload.email || '',
    expiresAt: payload.exp || null,
  };
}

async function verifyOnlineLicense(key, { machineId } = {}) {
  const url = (process.env.KLIVA_LICENSE_URL || '').trim();
  if (!url) return null;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, machineId }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    return { ok: false, reason: `Servidor de licenca respondeu ${res.status}.` };
  }

  const data = await res.json();
  if (!data?.ok) {
    return { ok: false, reason: data?.reason || 'Licenca recusada pelo servidor.' };
  }

  return {
    ok: true,
    email: data.email || '',
    expiresAt: data.expiresAt || null,
  };
}

export async function validateLicense() {
  const key = (process.env.KLIVA_LICENSE_KEY || '').trim();
  if (!key) {
    return { ok: false, reason: 'KLIVA_LICENSE_KEY nao configurada no .env.' };
  }

  const cached = readCache();
  if (cached) {
    return { ok: true, email: cached.email || '', expiresAt: cached.expiresAt || null, cached: true };
  }

  const machineId = getMachineId();

  try {
    const online = await verifyOnlineLicense(key, { machineId });
    if (online) {
      if (online.ok) writeCache(key, online.expiresAt);
      return online;
    }
  } catch (err) {
    const offline = verifyOfflineLicense(key, { machineId });
    if (offline.ok) {
      writeCache(key, offline.expiresAt);
      return offline;
    }
    return {
      ok: false,
      reason: `Falha ao validar licenca online: ${err.message}`,
    };
  }

  const offline = verifyOfflineLicense(key, { machineId });
  if (offline.ok) writeCache(key, offline.expiresAt);
  return offline;
}

export async function assertLicenseOrExit() {
  const result = await validateLicense();
  if (result.ok) {
    const exp = result.expiresAt
      ? new Date(result.expiresAt).toLocaleDateString('pt-BR')
      : 'sem expiracao';
    console.log(`[KLIVA] Licenca valida${result.email ? ` (${result.email})` : ''} — expira: ${exp}`);
    return result;
  }

  console.error('\n[KLIVA] Licenca invalida ou ausente.');
  console.error(`[KLIVA] ${result.reason}`);
  console.error('[KLIVA] Coloque KLIVA_LICENSE_KEY no arquivo .env e tente novamente.\n');
  process.exit(1);
}
