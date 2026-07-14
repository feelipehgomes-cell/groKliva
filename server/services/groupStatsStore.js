import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../../bot/shared/config.js';

const STATS_FILE = path.join(ROOT_DIR, 'data', 'group-stats.json');

function readStats() {
  if (!fs.existsSync(STATS_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeStats(stats) {
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
}

function defaultEntry() {
  return { activatedCount: 0, resetAt: new Date().toISOString() };
}

export function getGroupStats(groupId) {
  const stats = readStats();
  return stats[groupId] || { activatedCount: 0, resetAt: null };
}

export function getAllGroupStats() {
  return readStats();
}

export function incrementActivatedCount(groupId, amount = 1) {
  const id = String(groupId || '').trim();
  if (!id) return defaultEntry();

  const stats = readStats();
  const entry = stats[id] || defaultEntry();
  entry.activatedCount = Math.max(0, (entry.activatedCount || 0) + amount);
  stats[id] = entry;
  writeStats(stats);
  return entry;
}

export function resetGroupStats(groupId) {
  const id = String(groupId || '').trim();
  if (!id) throw new Error('groupId obrigatorio');

  const stats = readStats();
  stats[id] = { activatedCount: 0, resetAt: new Date().toISOString() };
  writeStats(stats);
  return stats[id];
}
