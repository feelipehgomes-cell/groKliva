import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../../bot/shared/config.js';

const GROUPS_FILE = path.join(ROOT_DIR, 'data', 'whatsapp-groups.json');

function slugify(label) {
  return String(label || 'grupo')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'grupo';
}

function ensureUniqueSlug(base, existing) {
  let slug = base;
  let n = 2;
  const slugs = new Set(existing.map((g) => g.slug));
  while (slugs.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function readGroupsFile() {
  if (!fs.existsSync(GROUPS_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function writeGroupsFile(groups) {
  fs.mkdirSync(path.dirname(GROUPS_FILE), { recursive: true });
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2), 'utf8');
}

function loadGroups() {
  const existing = readGroupsFile();
  return existing || [];
}

/** @deprecated fila de contas e global — nao copia mais para grupo. */
function migrateGlobalAccounts(_defaultGroup) {
  /* noop */
}

export function listGroups({ enabledOnly = false } = {}) {
  const groups = loadGroups();
  if (enabledOnly) return groups.filter((g) => g.enabled !== false);
  return groups;
}

export function getGroupById(groupId) {
  const id = String(groupId || '').trim();
  if (!id) return null;
  return listGroups().find((g) => g.id === id) || null;
}

export function getGroupBySlug(slug) {
  const s = String(slug || '').trim();
  if (!s) return null;
  return listGroups().find((g) => g.slug === s) || null;
}

export function resolveGroupPaths(slug) {
  const base = path.join(ROOT_DIR, 'data', 'groups', slug);
  return {
    baseDir: base,
    accountsFile: path.join(base, 'accounts.txt'),
    resultsFile: path.join(base, 'results.json'),
    readyBackupDir: path.join(base, 'backup', 'ready-accounts'),
  };
}

export function resolveGroupPathsById(groupId) {
  const group = getGroupById(groupId);
  if (!group) throw new Error(`Grupo nao encontrado: ${groupId}`);
  return { group, paths: resolveGroupPaths(group.slug) };
}

export function ensureGroupDirs(slug) {
  const paths = resolveGroupPaths(slug);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.mkdirSync(paths.readyBackupDir, { recursive: true });
  return paths;
}

export function addGroup({ id, label }) {
  const jid = String(id || '').trim();
  const name = String(label || '').trim();
  if (!jid || !name) throw new Error('id e label sao obrigatorios');
  if (!jid.includes('@g.us')) throw new Error('id deve ser um JID de grupo (@g.us)');

  const groups = listGroups();
  if (groups.some((g) => g.id === jid)) {
    throw new Error('Grupo ja cadastrado');
  }

  const base = slugify(name);
  const slug = ensureUniqueSlug(base, groups);
  const group = {
    id: jid,
    label: name,
    slug,
    enabled: true,
    sendReadyPix: false,
    createdAt: new Date().toISOString(),
  };

  ensureGroupDirs(slug);
  groups.push(group);
  writeGroupsFile(groups);
  return group;
}

export function removeGroup(groupId) {
  const groups = listGroups();
  const idx = groups.findIndex((g) => g.id === groupId);
  if (idx === -1) throw new Error('Grupo nao encontrado');

  const [removed] = groups.splice(idx, 1);
  writeGroupsFile(groups);
  return removed;
}

export function setGroupEnabled(groupId, enabled) {
  return patchGroup(groupId, { enabled });
}

export function setGroupSendReadyPix(groupId, sendReadyPix) {
  return patchGroup(groupId, { sendReadyPix });
}

export function patchGroup(groupId, { enabled, sendReadyPix } = {}) {
  const groups = listGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw new Error('Grupo nao encontrado');
  if (enabled !== undefined) group.enabled = !!enabled;
  if (sendReadyPix !== undefined) group.sendReadyPix = !!sendReadyPix;
  writeGroupsFile(groups);
  return group;
}

export function groupSendReadyPixEnabled(groupId) {
  const group = getGroupById(groupId);
  return group?.sendReadyPix === true;
}
