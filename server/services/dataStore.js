import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from '../../bot/shared/config.js';
import {
  loadAccounts,
  parseAccountsText,
  removeAccountsFromFile,
} from '../../bot/shared/accounts/accounts.js';
import { summarizePayerResults, parsePayerResults } from '../../bot/shared/pix/payerStore.js';
import { getPaidCount, getPaidEmails, getPaidCredentials } from '../../bot/shared/pix/paidStore.js';
import {
  listReadyAccounts,
  releaseReadyAccounts,
  markReadyAccountsReleased,
} from './readyAccountsStore.js';
import { listGroups, resolveGroupPaths, resolveGroupPathsById, getGroupById } from './groupStore.js';
import { getGroupStats, getGlobalActivatedTotal } from './groupStatsStore.js';
import { botManager } from './botManager.js';

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

function accountsFileForGroup(_groupId = null) {
  return config.accountsFile;
}

let perGroupAccountsMerged = false;

/** Une contas antigas por grupo na fila global (uma vez). */
function mergePerGroupAccountsIntoGlobal() {
  if (perGroupAccountsMerged) return;
  perGroupAccountsMerged = true;

  const globalPath = resolveFile(config.accountsFile);
  const seen = new Set(
    loadAccounts(globalPath).map((a) => String(a.email || '').toLowerCase()).filter(Boolean),
  );
  let merged = 0;

  for (const g of listGroups()) {
    const paths = resolveGroupPaths(g.slug);
    if (!fs.existsSync(paths.accountsFile)) continue;

    const lines = [];
    for (const a of loadAccounts(paths.accountsFile)) {
      const key = String(a.email || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const name = a.nome || a.name || '';
      lines.push(`${a.email}|${a.password}|${name}`);
      merged += 1;
    }

    if (!lines.length) continue;
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    let prefix = '';
    if (fs.existsSync(globalPath)) {
      const existing = fs.readFileSync(globalPath, 'utf8');
      if (existing.trim()) prefix = existing.endsWith('\n') ? '' : '\n';
    }
    fs.appendFileSync(globalPath, `${prefix}${lines.join('\n')}\n`, 'utf8');
  }

  if (merged > 0) {
    console.log(`[accounts] ${merged} conta(s) migrada(s) de grupos para fila global.`);
  }
}

function ensureGlobalAccountsReady() {
  mergePerGroupAccountsIntoGlobal();
}

export function listAccounts(_groupId = null) {
  ensureGlobalAccountsReady();
  const file = accountsFileForGroup();
  const accounts = loadAccounts(file).map((a, index) => ({
    index,
    email: a.email,
    password: a.password,
    name: a.nome || a.name || '',
  }));

  return {
    total: accounts.length,
    preview: accounts.slice(0, 5),
    shared: true,
  };
}

function resultsFileForGroup(groupId) {
  if (!groupId) return config.resultsFile;
  const { paths } = resolveGroupPathsById(groupId);
  return paths.resultsFile;
}

export async function addAccountsFromText(rawText, _groupId = null) {
  ensureGlobalAccountsReady();
  const text = String(rawText || '').trim();
  if (!text) throw new Error('Texto vazio');

  const parsed = parseAccountsText(text);
  if (!parsed.length) {
    throw new Error('Nenhuma conta valida. Formato: email|senha| (uma por linha)');
  }

  const filePath = resolveFile(accountsFileForGroup(_groupId));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let prefix = '';
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing.trim()) prefix = existing.endsWith('\n') ? '' : '\n';
  }

  const lines = parsed
    .map((a) => {
      const name = a.nome || a.name || '';
      return `${a.email}|${a.password}|${name}`;
    })
    .join('\n');

  fs.appendFileSync(filePath, `${prefix}${lines}\n`, 'utf8');
  return listAccounts();
}

export async function addAccount({ email, password, name }) {
  const lines = [`${email}|${password}|${name || ''}`].join('\n');
  return addAccountsFromText(lines);
}

export async function deleteAccount(email, _groupId = null) {
  ensureGlobalAccountsReady();
  const file = accountsFileForGroup();
  await removeAccountsFromFile([email], file);
  return listAccounts();
}

export function getActivationResults(limit = 50, groupId = null) {
  const file = groupId ? resultsFileForGroup(groupId) : config.resultsFile;
  const local = readJsonArray(file);
  if (!groupId) return local.slice(-limit).reverse();

  // Inclui results antigos no arquivo global com o mesmo groupId
  const globalRows = readJsonArray(config.resultsFile).filter(
    (r) => String(r?.groupId || '') === String(groupId),
  );
  const byEmail = new Map();
  for (const r of [...globalRows, ...local]) {
    const key = String(r?.email || '')
      .trim()
      .toLowerCase();
    if (key) byEmail.set(key, r);
  }
  return [...byEmail.values()]
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    .slice(-limit)
    .reverse();
}

export function listCpfs() {
  const summary = summarizePayerResults();
  const blocks = summary.blocks.map((b) => ({
    cpf: b.cpf,
    nome: b.name || b.nome || '',
    used: b.used ?? 0,
    remaining: b.remaining ?? summary.cap,
  }));

  return {
    cap: summary.cap,
    totalSlots: summary.totalSlots,
    totalBlocks: blocks.length,
    preview: blocks.slice(0, 5),
  };
}

export function getCpfState() {
  const statePath = resolveFile(config.payerResultsStateFile);
  if (!fs.existsSync(statePath)) return { usageByCpf: {}, byEmail: {} };
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

export async function addCpfsFromText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) throw new Error('Texto vazio');

  const parsed = parsePayerResults(text);
  if (!parsed.length) {
    throw new Error(
      'Nenhuma linha valida. Use o formato cpf|nome (uma por linha).',
    );
  }

  const filePath = resolveFile(config.payerResultsFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let prefix = '';
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing.trim()) prefix = existing.endsWith('\n') ? '\n' : '\n\n';
  }

  const payload = text.endsWith('\n') ? text : `${text}\n`;
  fs.appendFileSync(filePath, prefix + payload, 'utf8');
  return listCpfs();
}

export async function addCpf({ nome, cpf }) {
  const filePath = resolveFile(config.payerResultsFile);
  const line = `${cpf.replace(/\D/g, '')}|${nome.trim().toUpperCase()}`;

  let prefix = '';
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing.trim()) prefix = existing.endsWith('\n') ? '' : '\n';
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${prefix}${line}\n`, 'utf8');
  return listCpfs();
}

export async function deleteCpf(cpfRaw) {
  const cpf = cpfRaw.replace(/\D/g, '');
  const filePath = resolveFile(config.payerResultsFile);
  if (!fs.existsSync(filePath)) return listCpfs();

  const parsed = parsePayerResults(fs.readFileSync(filePath, 'utf8'));
  const kept = parsed.filter((b) => b.cpf !== cpf);

  const body = kept.map((b) => `${b.cpf}|${b.name}`).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');

  // Limpa uso/reservas do CPF removido (mesma regra do bot ao detectar recusa).
  try {
    const statePath = resolveFile(config.payerResultsStateFile);
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.usageByCpf?.[cpf]) delete state.usageByCpf[cpf];
      if (state.byEmail && typeof state.byEmail === 'object') {
        for (const [email, mapped] of Object.entries(state.byEmail)) {
          if (String(mapped) === cpf) delete state.byEmail[email];
        }
      }
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    }
  } catch {
    /* noop */
  }

  return listCpfs();
}

function buildPasswordMap() {
  const map = new Map();
  for (const a of loadAccounts(config.accountsFile)) {
    if (a.email && a.password) map.set(a.email.toLowerCase(), a.password);
  }

  for (const r of getActivationResults(500)) {
    const key = String(r.email || '').toLowerCase();
    if (key && r.password && !map.has(key)) map.set(key, r.password);
  }

  for (const [email, password] of getPaidCredentials()) {
    if (!map.has(email)) map.set(email, password);
  }

  return map;
}

function credentialLine(email, password) {
  if (!email) return '';
  if (!password) return '';
  return `${email}|${password}`;
}

function enrichResult(result, passwordMap) {
  const password =
    result.password || passwordMap.get(String(result.email || '').toLowerCase()) || '';
  return {
    ...result,
    password,
    credential: credentialLine(result.email, password),
  };
}

export function getDashboard() {
  const cpfs = listCpfs();
  const paidCount = getPaidCount();
  const paidEmails = getPaidEmails();
  const passwordMap = buildPasswordMap();

  const today = new Date().toISOString().slice(0, 10);

  const groups = listGroups().map((g) => {
    const activations = getActivationResults(500, g.id);
    const activatedToday = activations.filter(
      (r) => r.at?.startsWith(today) && r.paymentConfirmed === true,
    ).length;
    const stats = getGroupStats(g.id);
    return {
      id: g.id,
      label: g.label,
      slug: g.slug,
      enabled: g.enabled !== false,
      activatedToday,
      activatedCount: stats.activatedCount || 0,
      resetAt: stats.resetAt || null,
      running: botManager.isActivateRunning(g.id),
      readyActivate: listReadyAccounts('activate', passwordMap, g.slug),
    };
  });

  const globalAccounts = listAccounts();
  const accountsTotal = globalAccounts.total;
  for (const g of groups) {
    g.accountsTotal = accountsTotal;
  }
  const activatedToday = groups.reduce((sum, g) => sum + g.activatedToday, 0);
  const activations = groups.flatMap((g) =>
    getActivationResults(15, g.id).map((r) => enrichResult({ ...r, groupId: g.id }, passwordMap)),
  );
  const recentActivations = activations
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, 15);

  const readyActivate = listReadyAccounts('activate', passwordMap);

  return {
    paidCount,
    paidEmailsCount: paidEmails.size,
    accountsTotal,
    cpfsAvailable: cpfs.totalBlocks,
    cpfsTotalSlots: cpfs.totalSlots,
    activatedToday,
    activatedTotal: getGlobalActivatedTotal(),
    readyActivate,
    recentActivations,
    groups,
  };
}

export function copyReadyAccounts(kind, count = 0, groupId = null) {
  const passwordMap = buildPasswordMap();
  const group = groupId ? getGroupById(groupId) : null;
  return releaseReadyAccounts(kind, count, passwordMap, group?.slug || null);
}

/** Marca emails enviados (ex.: WhatsApp) como liberados da lista de prontas. */
export function markCopiedReadyAccounts(kind, emails = [], groupId = null) {
  const passwordMap = buildPasswordMap();
  const group = groupId ? getGroupById(groupId) : null;
  return markReadyAccountsReleased(kind, emails, passwordMap, group?.slug || null);
}
