import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { config, ROOT_DIR } from '../config.js';
import {
  parseWhatsAppCommand,
  isAuthorizedCommand,
  getWhatsAppAdminPhones,
} from './whatsappCommandHandler.js';
import {
  recordMessageReaction,
  aggregateReactionEntries,
  extractReactionFromEvent,
  extractReactionFromUpsert,
  formatReactionReport,
  getTodayReactionCounts,
  getConfirmedWaIdSet,
  isConfirmedPixMessage,
  messageReactionId,
  registerConfirmedPixMessages,
  replaceTodayReactionSnapshot,
  recomputeCountsFromMessages,
  normalizeReactionAtMs,
  waMessageId,
} from './reactionCountStore.js';

const logger = pino({ level: 'silent' });
const PENDING_REPLY_TEXT = 'pendente ⏱️';
const MAX_CACHED_GROUP_MSGS = 400;
const PIX_QUOTES_PATH = path.join(ROOT_DIR, 'data', 'whatsapp-pix-quotes.json');

/** Mensagens recentes por grupo — usado para achar PIX ja enviado e responder. */
const groupMessageCache = new Map();

let socketPromise = null;
let bootingSocket = null;
let hubReconnectPromise = null;
let hubReconnectTimer = null;
/** Incrementa ao invalidar — sessoes antigas param de reconectar. */
let sessionGeneration = 0;
const socketReadyCallbacks = [];
const socketLostCallbacks = [];
let sendChain = Promise.resolve();
let hubPaused = false;
/** Bloqueia reconexao do hub durante login QR na UI. */
let loginUiActive = false;
/** Socket + JID do grupo — reutilizado nos avisos inicio/fim (evita reconectar no Ctrl+C). */
let noticeSocket = null;
let noticeGroupJid = null;
let activeSocket = null;

function notifySocketReady(sock) {
  if (!sock) return;
  for (const cb of socketReadyCallbacks) {
    try {
      cb(sock);
    } catch {
      /* noop */
    }
  }
}

/** Hub do servidor reanexa comandos sempre que o socket Baileys reconecta. */
export function onBaileysSocketReady(cb) {
  if (typeof cb === 'function') socketReadyCallbacks.push(cb);
}

/** Disparado quando a sessao cai (close, invalidate). */
export function onBaileysSocketLost(cb) {
  if (typeof cb === 'function') socketLostCallbacks.push(cb);
}

function notifySocketLost(reason = '') {
  for (const cb of socketLostCallbacks) {
    try {
      cb(reason);
    } catch {
      /* noop */
    }
  }
}

function scheduleHubReconnect(log) {
  if (hubReconnectPromise || hubPaused || loginUiActive || !pendingCommandListener) return;
  if (hubReconnectTimer) return;
  const hubLog = pendingCommandListener.log || log;
  hubReconnectTimer = setTimeout(() => {
    hubReconnectTimer = null;
    hubReconnectPromise = getBaileysSocket({ log: hubLog, timeoutMs: 45000 })
      .then(() => {
        hubLog?.info?.('WhatsApp: hub reconectado — comandos ativos.');
      })
      .catch((err) => {
        hubLog?.warn?.(`Hub reconnect falhou: ${err.message} — nova tentativa em 20s.`);
        setTimeout(() => scheduleHubReconnect(hubLog), 20_000);
      })
      .finally(() => {
        hubReconnectPromise = null;
      });
  }, 4000);
}

async function endBaileysSocket(sock) {
  if (!sock) return;
  try {
    if (typeof sock.end === 'function') {
      await sock.end(undefined);
      return;
    }
  } catch {
    /* noop */
  }
  try {
    sock.ws?.close?.();
  } catch {
    /* noop */
  }
}

function invalidateBaileysSocket(log, reason = '') {
  sessionGeneration += 1;
  if (reason) log?.info?.(`WhatsApp: invalidando socket (${reason}).`);

  const sockets = [activeSocket, noticeSocket].filter(Boolean);
  activeSocket = null;
  noticeSocket = null;
  socketPromise = null;

  for (const sock of sockets) {
    void endBaileysSocket(sock);
  }

  notifySocketLost(reason);
  scheduleHubReconnect(log);
}

function isSocketAlive(sock) {
  if (!sock?.user?.id) return false;
  const ws = sock.ws;
  if (!ws) return true;
  // Baileys 7: sock.ws e um WebSocketClient (getters isOpen/isConnecting),
  // que NAO expoe readyState. Usar readyState (undefined) marcava todo socket
  // recem-aberto como "morto" e causava loop de invalidacao/reconexao.
  if (typeof ws.isOpen === 'boolean' || typeof ws.isConnecting === 'boolean') {
    return !!(ws.isOpen || ws.isConnecting);
  }
  // Fallback p/ ws cru (versoes antigas): 0=CONNECTING, 1=OPEN.
  return ws.readyState === 0 || ws.readyState === 1;
}

/** Socket fechado de fato (Baileys 7: isClosed; fallback: readyState CLOSED). */
function isSocketClosed(sock) {
  const ws = sock?.ws;
  if (!ws) return false;
  if (typeof ws.isClosed === 'boolean') return ws.isClosed;
  return ws.readyState === 3;
}

function isReconnectableWhatsAppError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('connection closed') ||
    msg.includes('connection terminated') ||
    msg.includes('connection lost') ||
    msg.includes('socket hang up') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('not connected')
  );
}

async function sendWithBaileysRetry(task, { log, label = 'envio' } = {}) {
  const max = Math.max(1, config.whatsappSendRetries || 3);
  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastErr = err;
      if (!isReconnectableWhatsAppError(err) || attempt >= max) throw err;
      log?.warn?.(
        `WhatsApp falhou no ${label} (${err.message}) — reconectando (${attempt}/${max})...`,
      );
      invalidateBaileysSocket(log);
      await sleep(1200 * attempt);
    }
  }
  throw lastErr;
}

function authDir() {
  const rel = String(config.whatsappAuthDir || 'whatsapp-auth').trim();
  if (path.isAbsolute(rel)) return rel;
  return path.join(ROOT_DIR, rel);
}

async function resolveBaileysVersion(log) {
  const envVersion = (process.env.WHATSAPP_BAILEYS_VERSION || '').trim();
  if (envVersion) {
    const parts = envVersion.split(/[.,]/).map((n) => parseInt(n, 10));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      log?.info?.(`WhatsApp: versao ${parts.join('.')} (WHATSAPP_BAILEYS_VERSION)`);
      return parts;
    }
  }

  try {
    const result = await fetchLatestBaileysVersion();
    if (result?.version?.length === 3) {
      log?.info?.(`WhatsApp: versao ${result.version.join('.')} (latest)`);
      return result.version;
    }
    if (result?.error) {
      log?.warn?.(`fetchLatestBaileysVersion: ${result.error?.message || result.error}`);
    }
  } catch (err) {
    log?.warn?.(`fetchLatestBaileysVersion falhou: ${err.message}`);
  }

  const fallback = [2, 3000, 1033846690];
  log?.warn?.(`WhatsApp: usando versao fallback ${fallback.join('.')}`);
  return fallback;
}

function credsFilePath() {
  return path.join(authDir(), 'creds.json');
}

/** Copia de seguranca do ultimo creds.json valido (registered=true). */
function credsBackupPath() {
  return path.join(authDir(), 'creds.json.bak');
}

/** Ultimo estado conhecido — evita loop de falso-negativo quando o disco esta ilegivel. */
let lastKnownRegistered = false;

/**
 * Sessao pareada?
 * - Login por CODIGO (pairing code): Baileys seta creds.registered = true.
 * - Login por QR (Baileys 7): NAO seta registered, mas grava me.id + account
 *   (ADVSignedDeviceIdentity) apos o pareamento. Exigir apenas registered===true
 *   fazia toda sessao de QR ser tratada como "inexistente".
 * me.id sozinho nao basta (pode existir num handshake interrompido); o par
 * me.id + account so aparece junto quando o pareamento realmente completou.
 */
function credsArePaired(creds) {
  if (!creds) return false;
  if (creds.registered === true) return true;
  return !!(creds.me?.id && creds.account);
}

/**
 * Le e classifica o creds.json:
 *  - 'registered'   -> sessao valida (pareada)
 *  - 'unregistered' -> arquivo ok, mas ainda nao pareou (QR/pareamento em curso)
 *  - 'unreadable'   -> vazio/parcial/corrompido (provavel escrita em andamento)
 *  - 'missing'      -> arquivo nao existe
 */
function readCredsState(file) {
  try {
    if (!fs.existsSync(file)) return 'missing';
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return 'unreadable';
    const creds = JSON.parse(raw);
    return credsArePaired(creds) ? 'registered' : 'unregistered';
  } catch {
    // JSON.parse falhou: writeFile do Baileys nao e atomico, entao pode ser
    // uma leitura pega no meio da gravacao. Tratar como transiente, nao "ausente".
    return 'unreadable';
  }
}

/**
 * Verifica se ha sessao valida no disco, de forma resiliente a leituras parciais.
 * A checagem antiga (fs.readFileSync direto) derrubava a conexao quando pegava o
 * creds.json no meio de uma gravacao nao-atomica do Baileys.
 */
function hasSavedSession() {
  let primary = readCredsState(credsFilePath());
  // Releitura imediata costuma pegar a escrita ja concluida (janela e minima).
  for (let i = 0; primary === 'unreadable' && i < 3; i++) {
    primary = readCredsState(credsFilePath());
  }

  if (primary === 'registered') {
    lastKnownRegistered = true;
    return true;
  }
  if (primary === 'unregistered') {
    lastKnownRegistered = false;
    return false;
  }

  // primary ausente/ilegivel -> tenta o backup do ultimo creds valido.
  const backup = readCredsState(credsBackupPath());
  if (backup === 'registered') {
    lastKnownRegistered = true;
    return true;
  }
  if (backup === 'unregistered') {
    lastKnownRegistered = false;
    return false;
  }

  // Nada legivel em disco: mantem o ultimo estado conhecido para nao derrubar
  // uma sessao boa por causa de uma leitura infeliz.
  return lastKnownRegistered;
}

/** Salva copia do creds.json quando ele esta valido (chamado no 'open'). */
function backupCredsFile(log) {
  try {
    if (readCredsState(credsFilePath()) !== 'registered') return;
    fs.copyFileSync(credsFilePath(), credsBackupPath());
  } catch (err) {
    log?.debug?.(`Backup creds falhou: ${err.message}`);
  }
}

/**
 * Restaura creds.json a partir do backup se o principal estiver
 * corrompido/vazio. Evita que o Baileys crie uma identidade nova (initAuthCreds)
 * e perca a sessao — que era o que forcava reconectar via QR.
 */
function restoreCredsFromBackupIfCorrupt(log) {
  const primary = readCredsState(credsFilePath());
  if (primary === 'registered' || primary === 'unregistered') return;
  if (readCredsState(credsBackupPath()) !== 'registered') return;
  try {
    fs.copyFileSync(credsBackupPath(), credsFilePath());
    log?.warn?.('creds.json ausente/corrompido — restaurado do backup (creds.json.bak).');
  } catch (err) {
    log?.warn?.(`Restaurar creds do backup falhou: ${err.message}`);
  }
}

/** Ultima poda de lid-mapping (throttle para nao varrer a pasta toda hora). */
let lastLidPruneAt = 0;

/**
 * Remove arquivos lid-mapping-*.json em excesso. Sao apenas cache de mapeamento
 * LID<->telefone (recriados sob demanda), nao material de sessao. Milhares deles
 * deixam a I/O lenta no Windows e ampliam a janela de escrita/leitura parcial.
 */
function pruneLidMappingBloat(log, { threshold = 400 } = {}) {
  const now = Date.now();
  if (now - lastLidPruneAt < 10 * 60 * 1000) return;
  lastLidPruneAt = now;
  try {
    const dir = authDir();
    if (!fs.existsSync(dir)) return;
    const lidFiles = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('lid-mapping-'));
    if (lidFiles.length <= threshold) return;
    let removed = 0;
    for (const f of lidFiles) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        removed += 1;
      } catch {
        /* noop */
      }
    }
    if (removed) {
      log?.info?.(`WhatsApp: limpeza de auth — ${removed} arquivo(s) lid-mapping removidos (cache).`);
    }
  } catch (err) {
    log?.debug?.(`Poda de lid-mapping falhou: ${err.message}`);
  }
}

/** Espera a sessao ser gravada de fato no disco (evita creds.json vazio). */
async function waitCredsPersisted({ timeoutMs = 15000, log } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (hasSavedSession()) return true;
    await sleep(300);
  }
  log?.warn?.('creds.json ainda nao persistiu apos espera.');
  return hasSavedSession();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractMessageBodyText(msg) {
  const unwrap = (message) => {
    if (!message) return null;
    if (message.ephemeralMessage?.message) return unwrap(message.ephemeralMessage.message);
    if (message.viewOnceMessage?.message) return unwrap(message.viewOnceMessage.message);
    if (message.viewOnceMessageV2?.message) return unwrap(message.viewOnceMessageV2.message);
    if (message.editedMessage?.message) return unwrap(message.editedMessage.message);
    return message;
  };

  const m = unwrap(msg?.message);
  if (!m) return '';
  return String(
    m.imageMessage?.caption ||
      m.extendedTextMessage?.text ||
      m.conversation ||
      m.buttonsResponseMessage?.selectedDisplayText ||
      m.listResponseMessage?.title ||
      '',
  ).trim();
}

function cacheGroupMessage(msg) {
  const jid = msg?.key?.remoteJid;
  if (!jid || !String(jid).endsWith('@g.us')) return;
  let list = groupMessageCache.get(jid);
  if (!list) {
    list = [];
    groupMessageCache.set(jid, list);
  }
  const id = msg.key?.id;
  if (id && list.some((x) => x.key?.id === id)) return;
  list.unshift(msg);
  if (list.length > MAX_CACHED_GROUP_MSGS) list.length = MAX_CACHED_GROUP_MSGS;
}

function attachBaileysMessageCache(sock) {
  if (sock.__grokPixMsgCache) return;
  sock.__grokPixMsgCache = true;

  const ingestHistory = (messages) => {
    for (const msg of messages || []) cacheGroupMessage(msg);
  };

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      cacheGroupMessage(msg);
      const entry = extractReactionFromUpsert(msg);
      if (entry && pendingReactionListener) {
        ingestReactionEntry(entry, pendingReactionListener);
      }
    }
  });

  sock.ev.on('messaging-history.set', ({ messages }) => {
    ingestHistory(messages);
  });
}

const SEEN_CMD_TTL_MS = 120_000;
const seenCommandIds = new Map();
/** Config do listener — reaplicada a cada reconexao do socket. */
let pendingCommandListener = null;
let pendingReactionListener = null;

function pruneSeenCommands() {
  const cutoff = Date.now() - SEEN_CMD_TTL_MS;
  for (const [id, ts] of seenCommandIds) {
    if (ts < cutoff) seenCommandIds.delete(id);
  }
}

function messageGroupJid(msg) {
  return msg?.key?.remoteJid || msg?.key?.remoteJidAlt || '';
}

function isTargetGroup(remote, groupJids) {
  if (!remote || !groupJids) return false;
  const list = Array.isArray(groupJids) ? groupJids : [groupJids];
  return list.some((gj) => isTargetGroupOne(remote, gj));
}

function isTargetGroupOne(remote, groupJid) {
  if (!remote || !groupJid) return false;
  const norm = (jid) => normalizeGroupJid(String(jid).split(':')[0]);
  const a = norm(remote);
  const b = norm(groupJid);
  if (a === b) return true;
  const idA = a.replace(/@.*$/, '');
  const idB = b.replace(/@.*$/, '');
  return idA.length >= 8 && idA === idB;
}

function ingestReactionEntry(entry, { groupJid, groupJids, log } = {}) {
  if (!entry?.messageKey?.id) return;
  const remote = entry.messageKey.remoteJid || entry.messageKey.remoteJidAlt || '';
  if (groupJids?.length) {
    if (!isTargetGroup(remote, groupJids)) return;
  } else if (groupJid && !isTargetGroup(remote, groupJid)) {
    return;
  }
  if (!isConfirmedPixMessage(entry.messageKey)) return;

  const emoji = String(entry.emoji || '').trim();
  recordMessageReaction({
    emoji,
    messageKey: entry.messageKey,
    at: entry.at,
  });

  if (emoji) {
    log?.info?.(
      `WhatsApp: reacao ${emoji} no PIX confirmado ${entry.messageKey.id}`,
    );
  }
}

export function collectReactionsForPixMessage(messageKey) {
  const targetWaId = waMessageId(messageKey);
  if (!targetWaId) return [];
  const entries = [];

  for (const list of groupMessageCache.values()) {
    for (const msg of list) {
      const fromUpsert = extractReactionFromUpsert(msg);
      if (fromUpsert && waMessageId(fromUpsert.messageKey) === targetWaId) {
        entries.push(fromUpsert);
      }

      if (waMessageId(msg.key) === targetWaId) {
        for (const reaction of msg.reactions || []) {
          if (!reaction?.text) continue;
        entries.push({
          messageKey: msg.key,
          emoji: reaction.text,
          at: normalizeReactionAtMs(reaction.senderTimestampMs) || messageTimestampMs(msg) || Date.now(),
          reactorKey: reaction.key,
        });
        }
      }
    }
  }

  return entries;
}

export function discoverConfirmedPixKeysFromCache(groupJid) {
  const keys = [];
  const seen = new Set();

  for (const [jid, list] of groupMessageCache) {
    if (!isTargetGroup(jid, groupJid)) continue;
    for (const msg of list) {
      const text = extractMessageBodyText(msg);
      if (!text.includes('Pagamento confirmado')) continue;

      const m = msg?.message;
      const ctx =
        m?.extendedTextMessage?.contextInfo ||
        m?.imageMessage?.contextInfo ||
        m?.conversation?.contextInfo;
      if (!ctx?.stanzaId) continue;

      const key = {
        remoteJid: ctx.remoteJid || jid,
        id: ctx.stanzaId,
      };
      const waId = waMessageId(key);
      if (!waId || seen.has(waId)) continue;
      seen.add(waId);
      keys.push(key);
    }
  }

  return keys;
}

async function refreshGroupHistoryCache(sock, groupJid, { log, count = 120 } = {}) {
  if (!sock?.fetchMessageHistory) return;

  let anchor = null;
  for (const [jid, list] of groupMessageCache) {
    if (!isTargetGroup(jid, groupJid) || !list.length) continue;
    anchor = list[list.length - 1];
    break;
  }

  if (!anchor?.key?.id) {
    log?.warn?.('/count: cache vazio — aguardando sync do WhatsApp.');
    return;
  }

  try {
    await sock.fetchMessageHistory(
      count,
      anchor.key,
      anchor.messageTimestamp || Date.now(),
    );
    await sleep(3000);
    log?.info?.('/count: historico do grupo atualizado.');
  } catch (err) {
    log?.warn?.(`/count: fetch historico falhou: ${err.message}`);
  }
}

function collectAllReactionsForConfirmedPix(groupJid, confirmedWaIds) {
  const entries = [];
  const seen = new Set();

  const push = (entry) => {
    const waId = waMessageId(entry?.messageKey);
    const emoji = String(entry?.emoji || '').trim();
    if (!waId || !emoji || !confirmedWaIds.has(waId)) return;
    const dedupe = `${waId}:${emoji}:${entry.at || 0}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    entries.push(entry);
  };

  for (const entry of scanCachedReactionsForGroup(groupJid)) {
    push(entry);
  }

  const stored = getTodayReactionCounts();
  for (const storeId of Object.keys(stored.confirmedPix || {})) {
    const waId = storeId.includes(':') ? storeId.split(':').pop() : storeId;
    if (!waId) continue;
    const key = { remoteJid: groupJid, id: waId };
    for (const entry of collectReactionsForPixMessage(key)) {
      push(entry);
    }
  }

  return entries;
}

export function resolvePixMessageKey({ copyPaste, waMessage, groupJid } = {}) {
  const jid = groupJid || noticeGroupJid;
  const hit = findPixMessageInGroup({
    groupJid: jid,
    copyPaste,
    waMessage: waMessage?.key?.id ? waMessage : null,
  });
  return hit?.key || waMessage?.key || null;
}

function scanCachedReactionsForGroup(groupJid) {
  const entries = [];
  for (const [jid, list] of groupMessageCache) {
    if (!isTargetGroup(jid, groupJid)) continue;
    for (const msg of list) {
      const fromUpsert = extractReactionFromUpsert(msg);
      if (fromUpsert) entries.push(fromUpsert);

      for (const reaction of msg.reactions || []) {
        if (!reaction?.text) continue;
          entries.push({
            messageKey: msg.key,
            emoji: reaction.text,
            at: normalizeReactionAtMs(reaction.senderTimestampMs) || messageTimestampMs(msg) || Date.now(),
          });
      }
    }
  }
  return entries;
}

function messageTimestampMs(msg) {
  const raw = msg?.messageTimestamp ?? msg?.key?.timestamp ?? 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function dispatchWhatsAppCommand(msg, { sock, groupJid, onCommand, log, groupJids, adminPhones }) {
  void (async () => {
    try {
      const command = parseWhatsAppCommand(extractMessageBodyText(msg));
      if (!command) return;
      if (!isAuthorizedCommand(msg, adminPhones)) {
        log?.warn?.('WhatsApp: comando ignorado (remetente nao autorizado).');
        return;
      }

      const msgAt = messageTimestampMs(msg);
      if (msgAt) {
        const lagMs = Date.now() - msgAt;
        if (lagMs > 3000) {
          log?.warn?.(
            `WhatsApp: /${command.name} entregue com ${Math.round(lagMs / 1000)}s de atraso.`,
          );
        }
      }

      log?.info?.(`WhatsApp: comando /${command.name} recebido (${groupJid}).`);
      await onCommand(command, { sock, groupJid, msg, log });
    } catch (err) {
      log?.warn?.(`WhatsApp comando: ${err.message}`);
      try {
        const replyJid = messageGroupJid(msg) || groupJids[0];
        await sendBaileysCommandReply({
          groupJid: replyJid,
          text: `❌ Erro: ${err.message}`.slice(0, 200),
          quoted: msg,
          log,
        });
      } catch {
        /* noop */
      }
    }
  })();
}

function bindCommandListeners(sock) {
  if (!pendingCommandListener || !sock?.ev) return;
  if (sock.__grokPixCmdListenerBound) return;

  sock.__grokPixCmdListenerBound = true;

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    const { groupJids, onCommand, log } = pendingCommandListener || {};
    if (!groupJids?.length || !onCommand) return;

    if (type && !['notify', 'append', 'prepend'].includes(type)) return;

    const adminPhones = getWhatsAppAdminPhones();

    for (const msg of messages) {
      const msgGroup = messageGroupJid(msg);
      const body = extractMessageBodyText(msg);
      const inMonitoredGroup = isTargetGroup(msgGroup, groupJids);

      if (body.startsWith('/') && !inMonitoredGroup) {
        log?.warn?.(
          `Comando ignorado — grupo ${msgGroup || '?'} nao esta habilitado no KLIVA.`,
        );
        continue;
      }

      if (!inMonitoredGroup) continue;

      if (body.startsWith('/') && !body.slice(1).trim()) continue;

      const id = msg.key?.id;
      if (id) {
        if (seenCommandIds.has(id)) continue;
        seenCommandIds.set(id, Date.now());
        pruneSeenCommands();
      }

      const command = parseWhatsAppCommand(body);
      if (!command) {
        if (body.startsWith('/')) {
          log?.debug?.(`Comando desconhecido em ${msgGroup}: ${body.slice(0, 40)}`);
        }
        continue;
      }

      dispatchWhatsAppCommand(msg, {
        sock,
        groupJid: msgGroup,
        onCommand,
        log,
        groupJids,
        adminPhones,
      });
    }
  });
}

/** Monta relatorio de reacoes de hoje (somente PIX com pagamento confirmado). */
export async function buildTodayReactionReportForGroup(groupJid, { log, sock } = {}) {
  if (sock) {
    await refreshGroupHistoryCache(sock, groupJid, { log });
  }

  const discovered = discoverConfirmedPixKeysFromCache(groupJid);
  if (discovered.length) {
    await registerConfirmedPixMessages(discovered);
    log?.info?.(`/count: ${discovered.length} PIX confirmado(s) encontrado(s) no cache.`);
  }

  const stored = getTodayReactionCounts();
  const confirmedWaIds = getConfirmedWaIdSet();
  const entries = collectAllReactionsForConfirmedPix(groupJid, confirmedWaIds);
  const aggregated = aggregateReactionEntries(entries, { confirmedWaIds });

  // Mescla persistido + cache (cache ganha por mensagem) — evita zerar se o cache estiver incompleto.
  const mergedMessages = { ...(stored.messages || {}), ...(aggregated.messages || {}) };
  const mergedCounts = recomputeCountsFromMessages(mergedMessages);

  await replaceTodayReactionSnapshot({
    counts: mergedCounts,
    messages: mergedMessages,
    confirmedPix: stored.confirmedPix,
  });

  const pixCount = getConfirmedWaIdSet().size;
  const total = Object.values(mergedCounts).reduce((s, n) => s + n, 0);
  log?.info?.(
    `WhatsApp: /count -> ${total} reacao(oes) em ${pixCount} PIX confirmado(s).`,
  );
  return formatReactionReport({
    dateKey: stored.dateKey,
    counts: mergedCounts,
    total,
    confirmedPixCount: pixCount,
  });
}

function bindReactionListeners(sock) {
  if (!pendingReactionListener || !sock?.ev || sock.__grokPixReactionListenerBound) return;

  sock.__grokPixReactionListenerBound = true;

  sock.ev.on('messages.reaction', (events) => {
    const { groupJids, log } = pendingReactionListener || {};
    if (!groupJids?.length) return;

    for (const event of events) {
      try {
        const entry = extractReactionFromEvent(event);
        if (!entry) continue;
        const remote = entry.messageKey.remoteJid || entry.messageKey.remoteJidAlt || '';
        if (remote && !isTargetGroup(remote, groupJids)) continue;
        if (!remote && !isConfirmedPixMessage(entry.messageKey)) continue;
        ingestReactionEntry(entry, { groupJid: remote, log });
      } catch (err) {
        log?.warn?.(`WhatsApp reacao: ${err.message}`);
      }
    }
  });
}

/**
 * Escuta comandos /start /stop /status no grupo configurado.
 * Persiste config para reanexar apos reconexao do Baileys.
 */
export function attachBaileysCommandListener(sock, { groupJid, groupJids, onCommand, log }) {
  const jids = groupJids || (groupJid ? [groupJid] : []);
  if (!jids.length || !onCommand) return;
  pendingCommandListener = { groupJids: jids.map(normalizeGroupJid), onCommand, log };
  bindCommandListeners(sock);
}

export function attachBaileysReactionListener(sock, { groupJid, groupJids, log }) {
  const jids = groupJids || (groupJid ? [groupJid] : []);
  if (!jids.length) return;
  pendingReactionListener = { groupJids: jids.map(normalizeGroupJid), log };
  bindReactionListeners(sock);
}

export function ensureBaileysCommandListener(sock) {
  bindCommandListeners(sock);
}

/**
 * Rastreia reacoes nos grupos (1 emoji por mensagem, contagem diaria).
 */
export function ensureBaileysReactionListener(sock) {
  bindReactionListeners(sock);
}

export async function warmBaileysHub({ log, groupJids = [] } = {}) {
  const sock = await getBaileysSocket({ log, timeoutMs: 30000 });
  return { sock, groupJids };
}

export function isBaileysHubPaused() {
  return hubPaused;
}

export function isBaileysLoginUiActive() {
  return loginUiActive;
}

export function setBaileysLoginUiActive(active) {
  loginUiActive = !!active;
}

export function pauseBaileysHub(log) {
  hubPaused = true;
  log?.info?.('WhatsApp: hub pausado para login.');
  const sockets = [activeSocket, noticeSocket].filter(Boolean);
  sessionGeneration += 1;
  activeSocket = null;
  noticeSocket = null;
  socketPromise = null;
  bootingSocket = null;
  for (const sock of sockets) {
    void endBaileysSocket(sock);
  }
}

export function resumeBaileysHub() {
  hubPaused = false;
}

function loadPixQuotesStore() {
  try {
    if (!fs.existsSync(PIX_QUOTES_PATH)) return {};
    return JSON.parse(fs.readFileSync(PIX_QUOTES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function savePixQuotesStore(store) {
  fs.mkdirSync(path.dirname(PIX_QUOTES_PATH), { recursive: true });
  fs.writeFileSync(PIX_QUOTES_PATH, JSON.stringify(store));
}

function persistPixQuote(copyPaste, waMessage) {
  const emv = String(copyPaste || '').trim();
  if (!emv || !waMessage?.key?.id) return;
  const store = loadPixQuotesStore();
  store[emv] = {
    key: waMessage.key,
    message: waMessage.message,
    at: Date.now(),
  };
  const keys = Object.keys(store);
  if (keys.length > 50) {
    keys.sort((a, b) => (store[a].at || 0) - (store[b].at || 0));
    for (let i = 0; i < keys.length - 50; delete store[keys[i++]]);
  }
  savePixQuotesStore(store);
}

function loadPersistedPixQuote(copyPaste) {
  const emv = String(copyPaste || '').trim();
  if (!emv) return null;
  const hit = loadPixQuotesStore()[emv];
  if (!hit?.key?.id) return null;
  return { key: hit.key, message: hit.message };
}

function emvMatchesMessage(copyPaste, msg) {
  const emv = String(copyPaste || '').trim();
  if (!emv) return false;
  const text = extractMessageBodyText(msg);
  if (!text) return false;
  if (text === emv || text.includes(emv) || emv.includes(text)) return true;
  const tail = emv.slice(-24);
  return tail.length >= 8 && text.includes(tail);
}

function findPixMessageInGroup({ groupJid, copyPaste, waMessage }) {
  if (waMessage?.key?.id && waMessage?.message) return waMessage;
  const persisted = loadPersistedPixQuote(copyPaste);
  if (persisted?.key?.id) return persisted;
  for (const msg of groupMessageCache.get(groupJid) || []) {
    if (emvMatchesMessage(copyPaste, msg)) return msg;
  }
  return null;
}

function normalizePhoneNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

function formatPairingCode(code) {
  const c = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (c.length === 8) return `${c.slice(0, 4)}-${c.slice(4)}`;
  return c;
}

function disconnectCode(lastDisconnect) {
  return lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.data?.reason;
}

function isLoggedOut(code) {
  return code === DisconnectReason.loggedOut || code === 401 || code === 403;
}

/**
 * Conexao Baileys — padrao baileys.wiki/docs/socket/connecting
 * - QR ou pairing code apos "connecting"
 * - restartRequired (515) -> novo socket com creds salvas
 */
export function runBaileysSession({
  log,
  phoneNumber = null,
  onPairingCode = null,
  onQr = null,
  timeoutMs = 300000,
} = {}) {
  const myGen = sessionGeneration;

  return new Promise((resolve, reject) => {
    let settled = false;
    let pairingScheduled = false;
    let pairingDone = false;
    let currentSock = null;
    let booting = false;
    let credsChain = Promise.resolve();
    const isStale = () => myGen !== sessionGeneration;

    const timer = setTimeout(() => {
      if (!isStale()) fail(new Error('Timeout aguardando conexao WhatsApp (5 min).'));
    }, timeoutMs);

    const succeed = (sock) => {
      if (settled || isStale()) return;
      settled = true;
      clearTimeout(timer);
      sock.__sessionGen = myGen;
      attachBaileysMessageCache(sock);
      ensureBaileysCommandListener(sock);
      ensureBaileysReactionListener(sock);
      notifySocketReady(sock);
      socketPromise = Promise.resolve(sock);
      resolve(sock);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const schedulePairing = (sock) => {
      if (pairingScheduled || pairingDone || !phoneNumber || !onPairingCode) return;
      if (sock.authState?.creds?.registered) return;

      pairingScheduled = true;
      setTimeout(async () => {
        try {
          if (isStale() || sock.authState?.creds?.registered) return;
          log?.info?.('WhatsApp: pedindo codigo de pareamento...');
          const code = await sock.requestPairingCode(phoneNumber);
          pairingDone = true;
          onPairingCode(code, phoneNumber);
        } catch (err) {
          pairingScheduled = false;
          log?.warn?.(`Pareamento falhou (${err.message}) — tentando de novo...`);
        }
      }, 3000);
    };

    const boot = async () => {
      if (booting || settled || isStale()) return;
      booting = true;

      try {
        fs.mkdirSync(authDir(), { recursive: true });
        // Recupera sessao se o creds.json principal ficou corrompido (evita QR novo).
        restoreCredsFromBackupIfCorrupt(log);
        // Reduz o inchaco da pasta (milhares de lid-mapping deixam a I/O lenta).
        pruneLidMappingBloat(log);
        const { state, saveCreds } = await useMultiFileAuthState(authDir());
        const version = await resolveBaileysVersion(log);

        const sock = makeWASocket({
          version,
          auth: state,
          logger,
          printQRInTerminal: false,
          markOnlineOnConnect: config.whatsappMarkOnlineOnConnect !== false,
          syncFullHistory: false,
          emitOwnEvents: true,
        });

        sock.__sessionGen = myGen;
        attachBaileysMessageCache(sock);

        currentSock = sock;

        const persistCreds = () => {
          credsChain = credsChain.then(() => saveCreds()).then(() => {
          }).catch((e) => {
            log?.warn?.('saveCreds falhou:', e.message);
          });
          return credsChain;
        };
        sock.ev.on('creds.update', persistCreds);

        sock.ev.on('connection.update', async (update) => {
          if (isStale()) return;

          const { connection, lastDisconnect, qr } = update;

          if (qr && onQr) {
            try {
              onQr(qr);
            } catch (e) {
              log?.warn?.('Erro ao exibir QR:', e.message);
            }
          }

          if (connection === 'connecting') {
            log?.info?.('WhatsApp: connecting');
            schedulePairing(sock);
          }

          if (connection === 'open') {
            if (isStale()) {
              await endBaileysSocket(sock);
              return;
            }
            if (!sock.authState?.creds?.registered && phoneNumber) {
              log?.info?.('WhatsApp: aguardando pareamento no celular...');
              return;
            }
            log?.info?.('WhatsApp: open');
            try {
              await persistCreds();
            } catch {
              /* noop */
            }
            await waitCredsPersisted({ log });
            // Guarda copia do creds.json valido — usado para restaurar se corromper.
            backupCredsFile(log);
            activeSocket = sock;
            attachBaileysMessageCache(sock);
            ensureBaileysCommandListener(sock);
            ensureBaileysReactionListener(sock);
            notifySocketReady(sock);
            sock.ev.on('connection.update', (post) => {
              if (post.connection !== 'close' || isStale()) return;
              const code = disconnectCode(post.lastDisconnect);
              const errMsg = post.lastDisconnect?.error?.message || '';
              if (activeSocket === sock) {
                invalidateBaileysSocket(
                  log,
                  `sessao caiu code=${code ?? '?'} ${errMsg}`.trim(),
                );
              }
            });
            succeed(sock);
            return;
          }

          if (connection === 'close') {
            const code = disconnectCode(lastDisconnect);
            const errMsg = lastDisconnect?.error?.message || '';
            log?.info?.(`WhatsApp: close (code=${code ?? '?'} ${errMsg})`.trim());

            if (isStale()) return;

            if (isLoggedOut(code)) {
              fail(new Error('WhatsApp recusou a sessao. Apague whatsapp-auth/ e tente de novo.'));
              return;
            }

            booting = false;
            currentSock = null;

            if (code === DisconnectReason.restartRequired) {
              log?.info?.('Restart necessario (normal apos QR/codigo). Novo socket...');
              pairingScheduled = false;
              await sleep(1000);
              if (!isStale()) await boot();
              return;
            }

            if (!settled) {
              const waitMs =
                code === DisconnectReason.connectionReplaced ? 6000 : 2500;
              if (code === DisconnectReason.connectionReplaced) {
                log?.warn?.('Conexao substituida (440) — aguardando antes de reconectar...');
              } else {
                log?.info?.('Reconectando...');
              }
              await sleep(waitMs);
              if (!isStale()) await boot();
            }
          }
        });
      } catch (err) {
        booting = false;
        if (isStale()) return;
        const msg = err?.message || String(err || 'erro desconhecido');
        const code = err?.code ? ` code=${err.code}` : '';
        log?.warn?.(`Boot falhou: ${msg}${code}`);
        if (!settled) {
          await sleep(2500);
          if (!isStale()) await boot();
        }
      } finally {
        booting = false;
      }
    };

    boot();
  });
}

export async function getBaileysSocket({ log, timeoutMs = 120000 } = {}) {
  if (hubPaused || loginUiActive) {
    throw new Error('WhatsApp hub pausado (login em andamento).');
  }

  // Prioriza o socket vivo e autenticado em memoria. O creds.json pode estar
  // momentaneamente ilegivel (escrita nao-atomica) sem a conexao ter caido —
  // e o gate de disco derrubava conexoes perfeitamente saudaveis.
  if (
    activeSocket?.__sessionGen === sessionGeneration &&
    activeSocket?.user?.id &&
    isSocketAlive(activeSocket) &&
    credsArePaired(activeSocket.authState?.creds)
  ) {
    attachBaileysMessageCache(activeSocket);
    ensureBaileysCommandListener(activeSocket);
    ensureBaileysReactionListener(activeSocket);
    return activeSocket;
  }

  if (!hasSavedSession()) {
    throw new Error('Sessao WhatsApp nao encontrada. Conecte pelo painel WhatsApp.');
  }

  if (socketPromise) {
    try {
      const cached = await socketPromise;
      if (cached?.__sessionGen === sessionGeneration && cached?.user?.id) {
        if (!isSocketAlive(cached)) {
          invalidateBaileysSocket(log, 'socket morto (cache)');
        } else {
          attachBaileysMessageCache(cached);
          ensureBaileysCommandListener(cached);
          ensureBaileysReactionListener(cached);
          return cached;
        }
      }
    } catch {
      socketPromise = null;
      bootingSocket = null;
    }
  }

  if (!bootingSocket) {
    const genAtStart = sessionGeneration;
    bootingSocket = runBaileysSession({ log, timeoutMs }).finally(() => {
      if (genAtStart === sessionGeneration) bootingSocket = null;
    });
    socketPromise = bootingSocket;
  }

  const sock = await socketPromise;
  if (sock?.__sessionGen !== sessionGeneration || !sock?.user?.id) {
    throw new Error('WhatsApp: conexao instavel — tente reconectar pelo painel.');
  }
  attachBaileysMessageCache(sock);
  ensureBaileysCommandListener(sock);
  ensureBaileysReactionListener(sock);
  return sock;
}

/** Responde a uma mensagem PIX ja enviada no grupo (quoted reply). */
async function replyBaileysToPixMessage({
  groupId,
  copyPaste,
  waMessage,
  text,
  log,
  label = 'reply',
  notFoundLog = 'PIX original nao encontrado no grupo.',
}) {
  if (!groupId && !noticeGroupJid) throw new Error('WHATSAPP_GROUP_ID ausente.');

  return enqueueBaileysSend(async () =>
    sendWithBaileysRetry(
      async () => {
        const sock = await getBaileysSocket({ log, timeoutMs: 45000 });
        const jid = normalizeGroupJid(groupId || noticeGroupJid);
        const emv = String(copyPaste || textFromWaMessage(waMessage) || '').trim();
        const quoted = findPixMessageInGroup({ groupJid: jid, copyPaste: emv, waMessage });

        if (!quoted) {
          log?.warn?.(notFoundLog);
          return { sent: false, reason: 'pix-message-not-found' };
        }

        await sock.sendMessage(jid, { text: String(text || '').trim() }, { quoted });
        log?.info?.(`WhatsApp: resposta enviada ao PIX no grupo (${label}).`);
        pinBaileysNoticeContext({ sock, groupJid: jid });
        return { sent: true, provider: 'baileys', replied: true };
      },
      { log, label },
    ),
  );
}

/** Responde a mensagem PIX ja enviada no grupo com "pendente ⏱️" (nao reenvia QR). */
export async function replyBaileysPendingToPix({ groupId, copyPaste, waMessage, log }) {
  return replyBaileysToPixMessage({
    groupId,
    copyPaste,
    waMessage,
    text: PENDING_REPLY_TEXT,
    log,
    label: 'pendente',
    notFoundLog:
      'PIX original nao encontrado no grupo — nao reenviando QR (aguardando pagamento).',
  });
}

/** Responde a mensagem PIX paga com texto de confirmacao. */
export async function replyBaileysConfirmationToPix({ groupId, copyPaste, waMessage, text, log }) {
  return replyBaileysToPixMessage({
    groupId,
    copyPaste,
    waMessage,
    text,
    log,
    label: 'confirmacao',
    notFoundLog: 'PIX original nao encontrado no grupo — confirmacao sem reply.',
  });
}

function textFromWaMessage(waMessage) {
  return extractMessageBodyText(waMessage);
}

export async function sendBaileysToGroup({ groupId, text, qrImagePath, log }) {
  if (!groupId) throw new Error('WHATSAPP_GROUP_ID ausente.');

  return enqueueBaileysSend(async () =>
    sendWithBaileysRetry(
      async () => {
        const sock = await getBaileysSocket({ log, timeoutMs: 45000 });
        const jid = normalizeGroupJid(groupId);
        const caption = String(text || '').trim().slice(0, 4096);

        let waMessage;
        if (qrImagePath && fs.existsSync(qrImagePath) && !qrImagePath.toLowerCase().endsWith('.svg')) {
          const buf = fs.readFileSync(qrImagePath);
          if (buf.length < 50) {
            log?.warn?.(`QR imagem invalida (${buf.length} bytes) — enviando so texto.`);
            waMessage = await sock.sendMessage(jid, { text: caption });
            log?.info?.('WhatsApp: texto enviado ao grupo (Baileys).');
          } else {
            waMessage = await sock.sendMessage(jid, {
              image: buf,
              mimetype: 'image/png',
              caption,
            });
            log?.info?.(`WhatsApp: QR + legenda em 1 mensagem (${buf.length} bytes).`);
          }
        } else {
          if (qrImagePath) log?.warn?.('Sem PNG do QR — enviando apenas texto.');
          waMessage = await sock.sendMessage(jid, { text: caption });
          log?.info?.('WhatsApp: texto enviado ao grupo (Baileys).');
        }

        if (waMessage) {
          cacheGroupMessage(waMessage);
          persistPixQuote(caption, waMessage);
        }

        pinBaileysNoticeContext({ sock, groupJid: jid });
        return { sent: true, provider: 'baileys', waMessage };
      },
      { log, label: 'PIX' },
    ),
  );
}

export function getBaileysNoticeContext() {
  return {
    groupJid: noticeGroupJid,
    hasSocket: isSocketAlive(noticeSocket),
  };
}

/** Resposta de comando com prioridade (nao fica atras de PIX na fila). */
export async function sendBaileysCommandReply({ groupJid, text, quoted, log } = {}) {
  const jid = normalizeGroupJid(groupJid);
  if (!jid) throw new Error('groupJid ausente.');

  const caption = String(text || '').trim().slice(0, 4096);
  if (!caption) return { sent: false, reason: 'empty' };

  prepareBaileysUrgentSend({ log });

  return sendWithBaileysRetry(
    async () => {
      const sock = await resolveNoticeSocket({ log });
      pinBaileysNoticeContext({ sock, groupJid: jid });
      await sock.sendMessage(jid, { text: caption }, quoted ? { quoted } : {});
      return { sent: true, provider: 'baileys' };
    },
    { log, label: 'comando' },
  );
}

export function prepareBaileysUrgentSend({ log } = {}) {
  sendChain = Promise.resolve();
  if (noticeSocket?.user?.id && !isSocketAlive(noticeSocket)) {
    if (isSocketClosed(noticeSocket)) {
      invalidateBaileysSocket(log, 'urgente: socket fechado');
    }
  }
}

export function enqueueBaileysSend(task) {
  const run = sendChain.then(task, task);
  sendChain = run.catch(() => {});
  return run;
}

export function pinBaileysNoticeContext({ sock, groupJid } = {}) {
  if (sock?.user?.id) noticeSocket = sock;
  if (groupJid) noticeGroupJid = groupJid;
}

/** Conecta e guarda socket/JID para avisos de inicio e fim do lote. */
export async function warmBaileysNotices({ log } = {}) {
  const groupId = await resolveWhatsAppGroupId({ log });
  const sock = await getBaileysSocket({ log, timeoutMs: 30000 });
  const groupJid = normalizeGroupJid(groupId);
  pinBaileysNoticeContext({ sock, groupJid });
  return { sock, groupJid };
}

async function resolveNoticeSocket({ log } = {}) {
  if (noticeSocket?.user?.id && isSocketAlive(noticeSocket)) {
    return noticeSocket;
  }
  if (noticeSocket) {
    if (isSocketClosed(noticeSocket)) {
      invalidateBaileysSocket(log, 'notice socket fechado');
    }
  }
  const sock = await getBaileysSocket({ log, timeoutMs: 20000 });
  pinBaileysNoticeContext({ sock });
  return sock;
}

/** Texto sem fila (inicio/fim do bot) — nao fica preso atras de PIX na fila. */
export async function sendBaileysTextUrgent({ groupId, text, log, groupJid } = {}) {
  const jid = groupJid || noticeGroupJid || normalizeGroupJid(groupId);
  if (!jid) throw new Error('WHATSAPP_GROUP_ID ausente.');

  return sendWithBaileysRetry(
    async () => {
      const sock = await resolveNoticeSocket({ log });
      if (!noticeGroupJid) pinBaileysNoticeContext({ groupJid: jid });

      const caption = String(text || '').trim().slice(0, 4096);
      await sock.sendMessage(jid, { text: caption });
      log?.info?.('WhatsApp: aviso enviado ao grupo (Baileys).');
      return { sent: true, provider: 'baileys' };
    },
    { log, label: 'aviso' },
  );
}

export function normalizeGroupJid(id) {
  const raw = String(id || '').trim();
  if (!raw) return raw;
  if (raw.includes('@')) return raw;
  return `${raw}@g.us`;
}

export async function listBaileysGroups({ log } = {}) {
  const sock = await getBaileysSocket({ log });
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups).map((g) => ({
    id: g.id,
    subject: g.subject,
    participants: g.participants?.length ?? 0,
  }));
}

/** Resolve grupo por WHATSAPP_GROUP_NAME (prioridade) ou WHATSAPP_GROUP_ID. */
export async function resolveWhatsAppGroupId({ log } = {}) {
  const name = (config.whatsappGroupName || '').trim();
  const id = (config.whatsappGroupId || '').trim();

  if (name) {
    const groups = await listBaileysGroups({ log });
    const wanted = name.toLowerCase();
    const exact = groups.find((g) => g.subject.toLowerCase() === wanted);
    const partial = groups.find((g) => g.subject.toLowerCase().includes(wanted));
    const match = exact || partial;
    if (!match) {
      const names = groups.map((g) => g.subject).sort().join(', ');
      throw new Error(
        `Grupo "${name}" nao encontrado. Disponiveis: ${names || '(nenhum)'}. Rode npm run whatsapp:groups`,
      );
    }
    log?.info?.(`WhatsApp grupo: "${match.subject}" (${match.id})`);
    return match.id;
  }

  if (id) return normalizeGroupJid(id);
  throw new Error('Defina WHATSAPP_GROUP_NAME ou WHATSAPP_GROUP_ID no .env');
}

export async function connectBaileysSavedSession(opts = {}) {
  if (!hasSavedSession()) {
    throw new Error('Nenhuma sessao salva. Rode npm run whatsapp:login');
  }
  opts.log?.info?.('Reconectando sessao salva...');
  return runBaileysSession(opts);
}

export async function connectBaileysWithPairingCode({ phoneNumber, onPairingCode, log, timeoutMs } = {}) {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) {
    throw new Error('Numero invalido. E.164 sem + (ex: 5573991560536).');
  }
  return runBaileysSession({ log, phoneNumber: normalized, onPairingCode, timeoutMs });
}

export async function connectBaileysWithQr({ onQr, log, timeoutMs } = {}) {
  return runBaileysSession({ log, onQr, timeoutMs });
}

export function clearBaileysAuth() {
  invalidateBaileysSocket();
  noticeGroupJid = null;
  // Wipe explicito: nao pode reportar sessao via last-known-good/backup depois.
  lastKnownRegistered = false;
  const dir = authDir();
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Encerra sockets ativos e cancela reconexoes (login UI, disconnect). */
export function resetBaileysConnection(log, reason = 'reset solicitado') {
  invalidateBaileysSocket(log, reason);
}

export function getBaileysSessionStatus() {
  const sock = activeSocket;
  const connected = !!(sock?.user?.id && isSocketAlive(sock));
  return {
    hasSession: hasSavedSession(),
    connected,
    userId: sock?.user?.id || null,
    hubPaused,
    loginUiActive,
    hasCommandListener: !!pendingCommandListener,
  };
}

export { hasSavedSession, normalizePhoneNumber, formatPairingCode };
