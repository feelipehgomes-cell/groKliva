import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';

const STORE_PATH = path.join(ROOT_DIR, 'data', 'whatsapp-reaction-counts.json');
const TZ = 'America/Sao_Paulo';

let chain = Promise.resolve();

export function normalizeReactionEmoji(raw) {
  const text = String(raw || '')
    .normalize('NFC')
    .replace(/\uFE0F/g, '')
    .trim();
  return text || '';
}

function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
}

function startOfTodayMs(date = new Date()) {
  const key = localDateKey(date);
  return new Date(`${key}T00:00:00-03:00`).getTime();
}

function formatDisplayDate(dateKey) {
  const [y, m, d] = dateKey.split('-');
  return `${d}/${m}/${y}`;
}

export function messageReactionId(key) {
  const jid = key?.remoteJid || key?.remoteJidAlt || '';
  const id = key?.id || '';
  if (!jid || !id) return null;
  return `${jid}:${id}`;
}

export function waMessageId(key) {
  return key?.id || (typeof key === 'string' ? key.split(':').pop() : null) || null;
}

function findConfirmedStoreId(day, messageKey) {
  const waId = waMessageId(messageKey);
  if (!waId || !day?.confirmedPix) return null;
  for (const storeId of Object.keys(day.confirmedPix)) {
    if (storeId === waId || storeId.endsWith(`:${waId}`)) return storeId;
  }
  return null;
}

function getConfirmedWaIdSet(date = new Date()) {
  const day = loadStore()[localDateKey(date)];
  const set = new Set();
  for (const storeId of Object.keys(day?.confirmedPix || {})) {
    const id = storeId.includes(':') ? storeId.split(':').pop() : storeId;
    if (id) set.add(id);
  }
  return set;
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function pruneOldDays(store, keepDateKey = localDateKey()) {
  for (const key of Object.keys(store)) {
    if (key !== keepDateKey) delete store[key];
  }
}

function dayBucket(store, dateKey) {
  if (!store[dateKey]) {
    store[dateKey] = { counts: {}, messages: {}, confirmedPix: {} };
  }
  if (!store[dateKey].confirmedPix) store[dateKey].confirmedPix = {};
  return store[dateKey];
}

function isConfirmedPixId(day, msgId) {
  if (!msgId || !day?.confirmedPix) return false;
  if (day.confirmedPix[msgId]) return true;
  const waId = waMessageId(msgId);
  return waId ? Boolean(findConfirmedStoreId(day, { id: waId })) : false;
}

export function isConfirmedPixMessage(messageKey, date = new Date()) {
  const day = loadStore()[localDateKey(date)];
  return Boolean(findConfirmedStoreId(day, messageKey));
}

function getConfirmedPixIdSet(date = new Date()) {
  return getConfirmedWaIdSet(date);
}

function applyReactionToDay(day, { emoji, messageKey }) {
  const storeId = findConfirmedStoreId(day, messageKey);
  if (!storeId) return;

  const text = normalizeReactionEmoji(emoji);
  const prev = day.messages[storeId];

  if (prev === text) return;

  if (prev) bumpCount(day.counts, prev, -1);

  if (text) {
    day.messages[storeId] = text;
    bumpCount(day.counts, text, 1);
  } else {
    delete day.messages[storeId];
  }
}

function bumpCount(counts, emoji, delta) {
  if (!emoji) return;
  const next = (counts[emoji] || 0) + delta;
  if (next <= 0) delete counts[emoji];
  else counts[emoji] = next;
}

function messageTimestampMs(msg) {
  const raw = msg?.messageTimestamp ?? msg?.key?.timestamp ?? 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Agrega contagens por emoji (1 emoji por mensagem alvo).
 * @param {Array<{ messageKey: object, emoji: string, at?: number }>} entries
 */
export function aggregateReactionEntries(entries, { date = new Date(), confirmedWaIds = null } = {}) {
  const todayStart = startOfTodayMs(date);
  const perMessage = new Map();

  for (const entry of entries) {
    const waId = waMessageId(entry.messageKey);
    const emoji = normalizeReactionEmoji(entry.emoji);
    if (!waId || !emoji) continue;
    if (confirmedWaIds && !confirmedWaIds.has(waId)) continue;

    const at = entry.at ?? Date.now();
    if (at < todayStart) continue;

    const prev = perMessage.get(waId);
    if (!prev || at >= prev.at) {
      perMessage.set(waId, { emoji, at, storeId: messageReactionId(entry.messageKey) });
    }
  }

  const counts = {};
  const messages = {};
  for (const [waId, { emoji, storeId }] of perMessage) {
    bumpCount(counts, emoji, 1);
    messages[storeId || waId] = emoji;
  }

  return {
    dateKey: localDateKey(date),
    counts,
    total: Object.values(counts).reduce((s, n) => s + n, 0),
    messages,
  };
}

export function mergeReactionCounts(...maps) {
  const merged = {};
  for (const counts of maps) {
    for (const [emoji, n] of Object.entries(counts || {})) {
      if (!emoji || !Number.isFinite(n) || n <= 0) continue;
      merged[emoji] = (merged[emoji] || 0) + n;
    }
  }
  return merged;
}

/**
 * Registra reacao em uma mensagem (1 emoji por mensagem alvo).
 */
export function recordMessageReaction({ emoji, messageKey, at } = {}) {
  const waId = waMessageId(messageKey);
  if (!waId) return chain;

  const when = at ?? Date.now();
  const dateKey = localDateKey(new Date(when));

  chain = chain.then(() => {
    const store = loadStore();
    pruneOldDays(store, dateKey);
    const day = dayBucket(store, dateKey);
    if (!findConfirmedStoreId(day, messageKey)) return;
    applyReactionToDay(day, { emoji, messageKey });
    saveStore(store);
  });

  return chain;
}

/** Marca QR PIX como pago — reacoes nesta mensagem passam a contar no /count. */
export function registerConfirmedPixMessage(messageKey, { backfillEntries = [], at } = {}) {
  const storeId = messageReactionId(messageKey) || waMessageId(messageKey);
  if (!storeId) return chain;

  const when = at ?? Date.now();
  const dateKey = localDateKey(new Date(when));

  chain = chain.then(() => {
    const store = loadStore();
    pruneOldDays(store, dateKey);
    const day = dayBucket(store, dateKey);
    day.confirmedPix[storeId] = when;

    for (const entry of backfillEntries) {
      applyReactionToDay(day, entry);
    }

    saveStore(store);
  });

  return chain;
}

/** Registra varios PIX confirmados de uma vez (ex.: varredura do cache no /count). */
export function registerConfirmedPixMessages(messageKeys, { at } = {}) {
  const when = at ?? Date.now();
  const dateKey = localDateKey(new Date(when));

  chain = chain.then(() => {
    const store = loadStore();
    pruneOldDays(store, dateKey);
    const day = dayBucket(store, dateKey);
    for (const messageKey of messageKeys) {
      const storeId = messageReactionId(messageKey) || waMessageId(messageKey);
      if (storeId) day.confirmedPix[storeId] = when;
    }
    saveStore(store);
  });

  return chain;
}

export function replaceTodayReactionSnapshot(snapshot, date = new Date()) {
  const dateKey = localDateKey(date);
  chain = chain.then(() => {
    const store = loadStore();
    pruneOldDays(store, dateKey);
    const prev = store[dateKey] || {};
    store[dateKey] = {
      counts: { ...(snapshot.counts || {}) },
      messages: { ...(snapshot.messages || {}) },
      confirmedPix: { ...(prev.confirmedPix || {}), ...(snapshot.confirmedPix || {}) },
    };
    saveStore(store);
  });
  return chain;
}

export function getTodayReactionCounts(date = new Date()) {
  const dateKey = localDateKey(date);
  const day = loadStore()[dateKey];
  if (!day?.counts) {
    return { dateKey, counts: {}, total: 0, messages: {}, confirmedPix: {} };
  }
  const counts = { ...day.counts };
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return {
    dateKey,
    counts,
    total,
    messages: { ...(day.messages || {}) },
    confirmedPix: { ...(day.confirmedPix || {}) },
  };
}

export function formatReactionReport({ dateKey, counts, total } = {}) {
  const displayDate = formatDisplayDate(dateKey || localDateKey());

  if (!total) {
    return `📊 Reações de hoje (${displayDate})\n\nNenhuma reação em PIX confirmado ainda.`;
  }

  const lines = Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([emoji, n]) => `${emoji} ${n}`);

  return [
    `📊 Reações em PIX pagos (${displayDate})`,
    '',
    ...lines,
    '',
    `Total: ${total} ${total === 1 ? 'mensagem' : 'mensagens'}`,
  ].join('\n');
}

export function formatTodayReactionReport(date = new Date()) {
  return formatReactionReport(getTodayReactionCounts(date));
}

/** Extrai reacao de uma mensagem upsert (reactionMessage). */
export function extractReactionFromUpsert(msg) {
  const rm = msg?.message?.reactionMessage;
  if (!rm?.key?.id) return null;

  return {
    messageKey: rm.key,
    emoji: rm.text,
    at: messageTimestampMs(msg),
    reactorKey: msg.key,
  };
}

/** Extrai reacao do evento messages.reaction. */
export function extractReactionFromEvent({ key, reaction } = {}) {
  if (!key?.id) return null;
  return {
    messageKey: key,
    emoji: reaction?.text,
    at: Number(reaction?.senderTimestampMs) || Date.now(),
    reactorKey: reaction?.key,
  };
}

export { messageTimestampMs, localDateKey, startOfTodayMs, getConfirmedPixIdSet, getConfirmedWaIdSet };
