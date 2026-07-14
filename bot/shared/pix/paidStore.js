import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from '../config.js';
import { removeAccountsFromFile, parseAccountsText } from '../accounts/accounts.js';

// Lock em processo: serializa read-modify-write dos arquivos (seguro com CONCURRENCY > 1).
let chain = Promise.resolve();

function countPath() {
  return path.isAbsolute(config.paidCountFile)
    ? config.paidCountFile
    : path.join(ROOT_DIR, config.paidCountFile);
}

function emailsPath() {
  return path.isAbsolute(config.paidEmailsFile)
    ? config.paidEmailsFile
    : path.join(ROOT_DIR, config.paidEmailsFile);
}

/** Le a contagem cumulativa atual (0 se ausente/invalida). */
export function getPaidCount() {
  try {
    const raw = fs.readFileSync(countPath(), 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function parsePaidEmailLine(trimmed) {
  if (!trimmed) return null;
  if (trimmed.includes('|')) {
    const email = trimmed.split('|')[0]?.trim().toLowerCase();
    return email && email.includes('@') ? email : null;
  }
  const parts = trimmed.split('\t');
  const email = (parts[1] || parts[0] || '').trim().toLowerCase();
  return email && email.includes('@') ? email : null;
}

/** Emails ja pagos (lowercase), deduplicados. */
export function getPaidEmails() {
  try {
    const raw = fs.readFileSync(emailsPath(), 'utf8');
    const set = new Set();
    for (const line of raw.split(/\r?\n/)) {
      const email = parsePaidEmailLine(line.trim());
      if (email) set.add(email);
    }
    return set;
  } catch {
    return new Set();
  }
}

/** Credenciais de contas pagas (email -> senha) a partir de paid-emails.txt. */
export function getPaidCredentials() {
  try {
    const raw = fs.readFileSync(emailsPath(), 'utf8');
    const map = new Map();
    for (const account of parseAccountsText(raw)) {
      const key = account.email?.toLowerCase();
      if (key && account.password) map.set(key, account.password);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Remove contas cujo email ja consta em paid-emails.txt. */
export function excludePaidAccounts(accounts, paidEmails = getPaidEmails()) {
  return accounts.filter((a) => !paidEmails.has(String(a.email || '').trim().toLowerCase()));
}

/**
 * Registra um pagamento: incrementa a contagem e faz append do email (e senha, se houver).
 * @returns {Promise<number>} novo total cumulativo
 */
export function registerPaid(email, password) {
  chain = chain.then(async () => {
    const current = getPaidCount();
    const next = current + 1;
    fs.writeFileSync(countPath(), String(next), 'utf8');
    const addr = String(email || '').trim() || '(sem email)';
    const pwd = String(password || '').trim();
    const line = pwd ? `${addr}|${pwd}|` : addr;
    fs.appendFileSync(emailsPath(), `${line}\n`, 'utf8');
    if (email) await removeAccountsFromFile([email]);
    return next;
  });
  return chain;
}
