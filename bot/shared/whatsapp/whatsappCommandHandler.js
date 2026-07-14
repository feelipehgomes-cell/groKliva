import { config, readConcurrencyFromEnv, readActivateLimitFromEnv } from '../config.js';

export function parseWhatsAppCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const body = raw.slice(1).trim();
  if (!body) return null;
  const [cmd, ...rest] = body.split(/\s+/);
  const aliases = {
    statuts: 'status',
    stats: 'status',
    estado: 'status',
    contagem: 'count',
    contar: 'count',
  };
  const name = aliases[cmd.toLowerCase()] || cmd.toLowerCase();
  if (!['start', 'stop', 'status', 'count'].includes(name)) return null;
  return { name, args: rest.join(' ').trim() };
}

export function getWhatsAppAdminPhones() {
  const raw = config.whatsappAdminPhones || config.whatsappPhoneNumber || '';
  return raw
    .split(/[,;]/)
    .map((s) => s.replace(/\D/g, ''))
    .filter((p) => p.length >= 10);
}

function phoneFromJid(jid) {
  return String(jid || '')
    .replace(/@.*$/, '')
    .replace(/\D/g, '');
}

export function isAuthorizedCommand(
  msg,
  adminPhones = getWhatsAppAdminPhones(),
) {
  if (config.whatsappCommandsPublic) return true;
  if (msg?.key?.fromMe) return true;
  const phone = phoneFromJid(msg?.key?.participant || msg?.participant);
  if (!phone) return false;
  if (!adminPhones.length) return false;
  return adminPhones.some(
    (admin) =>
      phone === admin || phone.endsWith(admin) || admin.endsWith(phone),
  );
}

export async function replyToCommand(sock, groupJid, quoted, text, log) {
  const { sendBaileysCommandReply } = await import('./whatsappBaileys.js');
  return sendBaileysCommandReply({ groupJid, text, quoted, log });
}

async function fetchKliva(path, options = {}) {
  const port = config.klivaPort || 4000;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

function formatKlivaStatus(data, groupJid) {
  const generate = data?.bots?.generate?.running ? '🟢 rodando' : '⚪ parado';
  const cpfSlots = data?.cpfsTotalSlots ?? 0;
  const cpfBlocks = data?.cpfsAvailable ?? 0;
  const readyGen = data?.readyGenerate?.length ?? 0;

  const group = (data?.groups || []).find((g) => g.id === groupJid);
  const lines = ['📊 Status grokPix', ''];

  if (group) {
    const bot = group.running ? '🟢 rodando' : '⚪ parado';
    lines.push(`📱 Grupo: ${group.label}`);
    lines.push(`🤖 Bot PIX: ${bot}`);
    lines.push(`✅ PIX ativados (marcador): ${group.activatedCount ?? 0}`);
    lines.push(`📅 Ativadas hoje: ${group.activatedToday ?? 0}`);
    lines.push('');
  }

  lines.push(`🧪 Gerador: ${generate}`);
  lines.push(`🪪 CPFs disponíveis: ${cpfSlots} vagas (${cpfBlocks} CPFs)`);
  if (readyGen > 0) {
    lines.push(`📦 Geradas p/ copiar: ${readyGen}`);
  }

  return lines.join('\n');
}

async function fetchKlivaStatus() {
  return fetchKliva('/api/dashboard');
}

async function fetchReactionCountReport(groupJid, log, sock) {
  const { buildTodayReactionReportForGroup } = await import('./whatsappBaileys.js');
  return buildTodayReactionReportForGroup(groupJid, { log, sock });
}

function isGroupActivateRunning(status, groupJid) {
  const activate = status?.activate;
  if (!activate || typeof activate !== 'object') return false;
  if (activate.running !== undefined) {
    return false;
  }
  return !!activate[groupJid]?.running;
}

/** Comandos no hub (socket unico no servidor). */
export async function handleServerWhatsAppCommand(
  command,
  { sock, groupJid, msg, log },
) {
  if (command.name === 'start') {
    const argN = parseInt(command.args, 10);
    const hasExplicit = Number.isFinite(argN) && argN >= 1;
    const conc = hasExplicit ? argN : readConcurrencyFromEnv();
    const limit = readActivateLimitFromEnv();

    await replyToCommand(
      sock,
      groupJid,
      msg,
      `🤖 Iniciando bot PIX (conc ${conc}${limit > 0 ? `, limite ${limit}` : ''})...`,
      log,
    );

    const status = await fetchKliva('/api/bots/status');
    if (isGroupActivateRunning(status, groupJid)) {
      await replyToCommand(sock, groupJid, msg, '⚠️ Bot PIX ja esta rodando neste grupo.', log);
      return;
    }

    await fetchKliva('/api/bots/activate/start', {
      method: 'POST',
      body: JSON.stringify({
        groupId: groupJid,
        ...(hasExplicit ? { concurrency: argN } : {}),
        limit,
        skipWhatsappStartNotice: true,
      }),
    });
    log?.info?.(`WhatsApp: /start -> bot activate iniciado (${groupJid}).`);
    return;
  }

  if (command.name === 'stop') {
    const status = await fetchKliva('/api/bots/status');
    const groupRunning = isGroupActivateRunning(status, groupJid);
    const generateRunning = status?.bots?.generate?.running || status?.generate?.running;

    if (!groupRunning && !generateRunning) {
      await replyToCommand(sock, groupJid, msg, '⚪ Nenhum bot esta rodando.', log);
      return;
    }

    await replyToCommand(sock, groupJid, msg, '⏹ Parando bot...', log);

    if (groupRunning) {
      await fetchKliva('/api/bots/activate/stop', {
        method: 'POST',
        body: JSON.stringify({ groupId: groupJid }),
      });
    }
    if (generateRunning) {
      await fetchKliva('/api/bots/generate/stop', { method: 'POST' });
    }
    log?.info?.(`WhatsApp: /stop -> bots parados (${groupJid}).`);
    return;
  }

  if (command.name === 'status') {
    const data = await fetchKlivaStatus();
    await replyToCommand(sock, groupJid, msg, formatKlivaStatus(data, groupJid), log);
    return;
  }

  if (command.name === 'count') {
    const report = await fetchReactionCountReport(groupJid, log, sock);
    await replyToCommand(sock, groupJid, msg, report, log);
  }
}

/** @deprecated comandos agora ficam apenas no hub do servidor */
export async function handleBotWhatsAppCommand(
  command,
  { sock, groupJid, msg, log },
) {
  return handleServerWhatsAppCommand(command, { sock, groupJid, msg, log });
}
