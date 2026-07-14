import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from '../../bot/shared/config.js';
import { getPaidEmails } from '../../bot/shared/pix/paidStore.js';
import { resolveGroupPaths, listGroups } from './groupStore.js';

const GLOBAL_BACKUP_DIR = path.join(ROOT_DIR, 'data', 'backup', 'ready-accounts');

function resolveFile(rel) {
  return path.isAbsolute(rel) ? rel : path.join(ROOT_DIR, rel);
}

function readJsonArray(filePath) {
  const full = resolveFile(filePath);
  if (!fs.existsSync(full)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function getGeneratedResults(limit = 2000) {
  return readJsonArray(config.generatedResultsFile).slice(-limit).reverse();
}

function backupDirForGroup(groupSlug) {
  if (groupSlug) {
    return resolveGroupPaths(groupSlug).readyBackupDir;
  }
  return GLOBAL_BACKUP_DIR;
}

function releasedPath(kind, groupSlug) {
  return path.join(backupDirForGroup(groupSlug), `released-${kind}.json`);
}

function ledgerPath(groupSlug) {
  return path.join(backupDirForGroup(groupSlug), 'ledger.txt');
}

function countPath(groupSlug) {
  return path.join(backupDirForGroup(groupSlug), 'total-count.txt');
}

function ensureBackupDir(groupSlug) {
  fs.mkdirSync(backupDirForGroup(groupSlug), { recursive: true });
}

function loadReleased(kind, groupSlug) {
  ensureBackupDir(groupSlug);
  const file = releasedPath(kind, groupSlug);
  if (!fs.existsSync(file)) return new Set();
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(Array.isArray(list) ? list.map((e) => String(e).toLowerCase()) : []);
  } catch {
    return new Set();
  }
}

function saveReleased(kind, set, groupSlug) {
  ensureBackupDir(groupSlug);
  fs.writeFileSync(releasedPath(kind, groupSlug), JSON.stringify([...set], null, 2), 'utf8');
}

function readBackupTotal(groupSlug) {
  ensureBackupDir(groupSlug);
  const file = countPath(groupSlug);
  if (!fs.existsSync(file)) return 0;
  const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function appendToBackup(accounts, groupSlug) {
  ensureBackupDir(groupSlug);
  const ledger = ledgerPath(groupSlug);
  const lines = accounts.map((a) => `${a.email}|${a.password}`);
  const existing = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '';
  const needsNl = existing.trim() && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(ledger, `${needsNl}${lines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(countPath(groupSlug), String(readBackupTotal(groupSlug) + accounts.length), 'utf8');
}

function credentialLine(email, password) {
  if (!email || !password) return '';
  return `${email}|${password}`;
}

function buildActivatePool(passwordMap) {
  const seen = new Set();
  const accounts = [];
  for (const g of listGroups()) {
    for (const a of buildActivatePoolForGroup(g.slug, passwordMap)) {
      const key = a.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      accounts.push(a);
    }
  }
  return accounts;
}

function buildActivatePoolForGroup(groupSlug, passwordMap) {
  const paths = resolveGroupPaths(groupSlug);
  const results = readJsonArray(paths.resultsFile);
  const seen = new Set();
  const accounts = [];

  for (const r of [...results].reverse()) {
    if (r?.paymentConfirmed !== true || !r?.email) continue;
    const email = String(r.email).trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    const password =
      String(r.password || '').trim() || passwordMap.get(email) || '';
    if (!password) continue;
    seen.add(email);
    accounts.push({
      email: r.email,
      password,
      credential: credentialLine(r.email, password),
    });
  }
  return accounts;
}

function buildGeneratePool(passwordMap) {
  const seen = new Set();
  const accounts = [];
  const results = getGeneratedResults(2000).slice().reverse();

  for (const r of results) {
    if (!r.ok) continue;
    const email = String(r.email || '').toLowerCase();
    if (!email || seen.has(email)) continue;
    const password = r.password || passwordMap.get(email) || '';
    if (!password) continue;
    seen.add(email);
    accounts.push({
      email: r.email,
      password,
      credential: credentialLine(r.email, password),
    });
  }
  return accounts;
}

function poolForKind(kind, passwordMap, groupSlug = null) {
  if (kind === 'activate') {
    if (groupSlug) return buildActivatePoolForGroup(groupSlug, passwordMap);
    return buildActivatePool(passwordMap);
  }
  if (kind === 'generate') return buildGeneratePool(passwordMap);
  throw new Error(`Tipo invalido: ${kind}`);
}

export function listReadyAccounts(kind, passwordMap, groupSlug = null) {
  const released = loadReleased(kind, groupSlug);
  return poolForKind(kind, passwordMap, groupSlug).filter(
    (a) => !released.has(a.email.toLowerCase()),
  );
}

/**
 * Contas pagas desta run — pool.results + diff em paid-emails.txt vs baseline do inicio.
 * Ignora contas ja marcadas como liberadas (released) quando groupSlug informado.
 */
export function accountsReadyFromRunDelta({
  runResults = [],
  passwordMap,
  baselinePaidEmails = null,
  groupSlug = null,
} = {}) {
  const released = groupSlug ? loadReleased('activate', groupSlug) : new Set();
  const seen = new Set();
  const out = [];

  const add = (email, password) => {
    const key = String(email || '').trim().toLowerCase();
    if (!key || seen.has(key) || released.has(key)) return;
    const pass = String(password || '').trim() || passwordMap.get(key) || '';
    if (!pass) return;
    seen.add(key);
    const addr = String(email).trim();
    out.push({
      email: addr,
      password: pass,
      credential: credentialLine(addr, pass),
    });
  };

  for (const r of Array.isArray(runResults) ? runResults : []) {
    if (!r?.email) continue;
    const paid =
      r.paymentConfirmed === true ||
      (r.ok === true && /pagamento confirmado/i.test(String(r.reason || '')));
    if (paid) add(r.email, r.password);
  }

  if (baselinePaidEmails) {
    for (const email of getPaidEmails()) {
      if (baselinePaidEmails.has(email)) continue;
      add(email, passwordMap.get(email));
    }
  }

  return out;
}

export function releaseReadyAccounts(kind, count = 0, passwordMap, groupSlug = null) {
  const ready = listReadyAccounts(kind, passwordMap, groupSlug);
  if (!ready.length) {
    throw new Error('Nenhuma conta disponivel para copiar.');
  }

  const take = count > 0 ? Math.min(count, ready.length) : ready.length;
  const batch = ready.slice(0, take);

  appendToBackup(batch, groupSlug);

  const released = loadReleased(kind, groupSlug);
  for (const a of batch) released.add(a.email.toLowerCase());
  saveReleased(kind, released, groupSlug);

  return {
    text: batch.map((a) => a.credential).join('\n'),
    copied: batch.length,
    remaining: ready.length - batch.length,
  };
}

export function markReadyAccountsReleased(kind, emails = [], passwordMap, groupSlug = null) {
  const wanted = new Set(
    (emails || [])
      .map((e) => String(e || '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (!wanted.size) {
    return { released: 0, remaining: listReadyAccounts(kind, passwordMap, groupSlug).length };
  }

  const released = loadReleased(kind, groupSlug);
  const batch = [];
  for (const emailKey of wanted) {
    if (released.has(emailKey)) continue;
    const password = String(passwordMap.get(emailKey) || '').trim();
    if (!password) continue;
    batch.push({
      email: emailKey,
      password,
      credential: credentialLine(emailKey, password),
    });
  }

  if (!batch.length) {
    return {
      released: 0,
      remaining: listReadyAccounts(kind, passwordMap, groupSlug).length,
    };
  }

  appendToBackup(batch, groupSlug);
  for (const a of batch) released.add(a.email.toLowerCase());
  saveReleased(kind, released, groupSlug);

  return {
    released: batch.length,
    remaining: listReadyAccounts(kind, passwordMap, groupSlug).length,
  };
}
