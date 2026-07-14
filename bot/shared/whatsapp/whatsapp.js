import fs from 'node:fs';
import { config } from '../config.js';
import { ensureQrImagePath } from '../pix/pixExtract.js';
import {
  sendBaileysToGroup,
  sendBaileysTextUrgent,
  replyBaileysPendingToPix,
  replyBaileysConfirmationToPix,
  resolveWhatsAppGroupId,
  normalizeGroupJid,
} from '../whatsapp/whatsappBaileys.js';

function isManagedMode() {
  return process.env.KLIVA_MANAGED === '1';
}

async function fetchKlivaApi(path, body = {}) {
  const port = config.klivaPort || 4000;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function resolveSendGroupId(explicit) {
  return explicit || config.klivaGroupId || config.whatsappGroupId;
}

/**
 * Envia dados PIX para o grupo WhatsApp configurado.
 * Providers: baileys (gratuito/nativo), webhook, evolution (legado).
 */
export async function sendPixToGroup({ email, copyPaste, qrImagePath, cpf, log, groupId } = {}) {
  if (!config.whatsappEnabled) {
    log?.debug?.('WhatsApp desabilitado (WHATSAPP_ENABLED=false).');
    return { sent: false, reason: 'disabled' };
  }

  const caption = buildPixCaption({ copyPaste });
  const provider = config.whatsappProvider;
  const targetGroupId = resolveSendGroupId(groupId);

  try {
    if (isManagedMode() && provider === 'baileys') {
      return fetchKlivaApi('/api/whatsapp/send-pix', {
        groupId: targetGroupId,
        email,
        copyPaste,
        qrImagePath,
        cpf,
      });
    }
    if (provider === 'webhook') {
      return await sendViaWebhook({ text: caption, copyPaste, qrImagePath, email, log });
    }
    if (provider === 'evolution') {
      return await sendViaEvolution({ text: caption, qrImagePath, log });
    }
    if (provider === 'baileys') {
      const gid = targetGroupId || (await resolveWhatsAppGroupId({ log }));
      const imagePath = await ensureQrImagePath({ copyPaste, qrImagePath, email, log });
      return await sendBaileysToGroup({
        groupId: gid,
        text: caption,
        qrImagePath: imagePath,
        log,
      });
    }
    throw new Error(`WHATSAPP_PROVIDER desconhecido: ${provider}`);
  } catch (err) {
    log?.error?.(`WhatsApp falhou: ${err.message}`);
    if (config.whatsappFailSoft) {
      return { sent: false, reason: err.message };
    }
    throw err;
  }
}

/**
 * Responde ao PIX ja enviado no grupo com "pendente ⏱️" (evita reenviar QR duplicado).
 * Bloqueia apenas se o PIX ja foi pago. Pode repetir a cada ciclo de espera.
 */
export async function replyPendingToPixMessage({ email, copyPaste, waMessage, log, groupId } = {}) {
  if (!config.whatsappEnabled) {
    log?.debug?.('WhatsApp desabilitado (WHATSAPP_ENABLED=false).');
    return { sent: false, reason: 'disabled' };
  }

  const { shouldSendPendingNotice } = await import('./pendingNoticeController.js');

  const gate = shouldSendPendingNotice({ email, copyPaste, waMessage });
  if (!gate.allow) {
    log?.info?.(`WhatsApp pendente bloqueado: ${gate.reason}`);
    return { sent: false, reason: gate.reason, blocked: true };
  }

  const provider = config.whatsappProvider;
  const pendingText = 'pendente ⏱️';
  const targetGroupId = resolveSendGroupId(groupId);

  try {
    let result;
    if (isManagedMode() && provider === 'baileys') {
      result = await fetchKlivaApi('/api/whatsapp/reply-pending', {
        groupId: targetGroupId,
        copyPaste,
        waMessage,
      });
    } else if (provider === 'baileys') {
      const gid = targetGroupId || (await resolveWhatsAppGroupId({ log }));
      result = await replyBaileysPendingToPix({ groupId: gid, copyPaste, waMessage, log });
    } else if (provider === 'webhook') {
      result = await sendViaWebhook({ text: pendingText, copyPaste: null, qrImagePath: null, email: null, log });
    } else if (provider === 'evolution') {
      result = await sendViaEvolution({ text: pendingText, qrImagePath: null, log });
    } else {
      throw new Error(`WHATSAPP_PROVIDER desconhecido: ${provider}`);
    }

    return result;
  } catch (err) {
    log?.error?.(`WhatsApp pendente falhou: ${err.message}`);
    if (config.whatsappFailSoft) {
      return { sent: false, reason: err.message };
    }
    throw err;
  }
}

/**
 * Envia mensagem de texto simples ao grupo (usa o provider atual).
 */
export async function sendTextToGroup({ text, log, urgent = false, groupId } = {}) {
  if (!config.whatsappEnabled) {
    log?.debug?.('WhatsApp desabilitado (WHATSAPP_ENABLED=false).');
    return { sent: false, reason: 'disabled' };
  }

  const provider = config.whatsappProvider;
  const targetGroupId = resolveSendGroupId(groupId);

  try {
    if (isManagedMode() && provider === 'baileys') {
      return fetchKlivaApi('/api/whatsapp/send-text', {
        groupId: targetGroupId,
        text,
        urgent,
      });
    }
    if (provider === 'webhook') {
      return await sendViaWebhook({ text, copyPaste: null, qrImagePath: null, email: null, log });
    }
    if (provider === 'evolution') {
      return await sendViaEvolution({ text, qrImagePath: null, log });
    }
    if (provider === 'baileys') {
      const gid = targetGroupId || (await resolveWhatsAppGroupId({ log }));
      if (urgent) {
        return await sendBaileysTextUrgent({ groupId: gid, text, log });
      }
      return await sendBaileysToGroup({ groupId: gid, text, log });
    }
    throw new Error(`WHATSAPP_PROVIDER desconhecido: ${provider}`);
  } catch (err) {
    log?.error?.(`WhatsApp falhou: ${err.message}`);
    if (config.whatsappFailSoft) {
      return { sent: false, reason: err.message };
    }
    throw err;
  }
}

/**
 * Confirmacao de pagamento — responde a mensagem do QR/PIX pago no grupo.
 */
export async function sendConfirmationToGroup({ email, count, copyPaste, waMessage, log, groupId, text: textOverride } = {}) {
  const text = textOverride?.trim() || [
    '✅ Pagamento confirmado com sucesso!',
    `Contador: #${count ?? '?'}`,
  ].join('\n');

  if (!config.whatsappEnabled) {
    log?.debug?.('WhatsApp desabilitado (WHATSAPP_ENABLED=false).');
    return { sent: false, reason: 'disabled' };
  }

  const provider = config.whatsappProvider;
  const targetGroupId = resolveSendGroupId(groupId);

  try {
    if (isManagedMode() && provider === 'baileys') {
      const result = await fetchKlivaApi('/api/whatsapp/reply-confirmation', {
        groupId: targetGroupId,
        copyPaste,
        waMessage,
        text,
        email,
        count,
      });
      if (result.sent !== false) {
        const { markPixPaidForPending } = await import('./pendingNoticeController.js');
        markPixPaidForPending({ email, copyPaste, waMessage });
      }
      return result;
    }
    if (provider === 'baileys') {
      const gid = targetGroupId || (await resolveWhatsAppGroupId({ log }));
      const result = await replyBaileysConfirmationToPix({
        groupId: gid,
        copyPaste,
        waMessage,
        text,
        log,
      });
      if (result.sent !== false) {
        const { markPixPaidForPending } = await import('./pendingNoticeController.js');
        markPixPaidForPending({ email, copyPaste, waMessage });
        await registerConfirmedPixForReactions({ copyPaste, waMessage, log, groupId: gid });
      }
      if (result.sent === false && result.reason === 'pix-message-not-found') {
        log?.warn?.('Enviando confirmacao como mensagem avulsa (PIX original nao encontrado).');
        return sendTextToGroup({ text, log, groupId: gid });
      }
      return result;
    }
    if (provider === 'webhook') {
      return await sendViaWebhook({ text, copyPaste: null, qrImagePath: null, email, log });
    }
    if (provider === 'evolution') {
      return await sendViaEvolution({ text, qrImagePath: null, log });
    }
    throw new Error(`WHATSAPP_PROVIDER desconhecido: ${provider}`);
  } catch (err) {
    log?.error?.(`WhatsApp confirmacao falhou: ${err.message}`);
    if (config.whatsappFailSoft) {
      return { sent: false, reason: err.message };
    }
    throw err;
  }
}

async function registerConfirmedPixForReactions({ copyPaste, waMessage, log, groupId } = {}) {
  try {
    const { registerConfirmedPixMessage } = await import('./reactionCountStore.js');
    const {
      resolvePixMessageKey,
      collectReactionsForPixMessage,
      normalizeGroupJid,
    } = await import('./whatsappBaileys.js');

    const groupJid = normalizeGroupJid(groupId || config.klivaGroupId || config.whatsappGroupId);
    const key = resolvePixMessageKey({ copyPaste, waMessage, groupJid });

    if (!key?.id) {
      log?.warn?.('PIX confirmado sem message key — reacao nao entrara no /count.');
      return;
    }

    const backfill = collectReactionsForPixMessage(key);
    await registerConfirmedPixMessage(key, { backfillEntries: backfill });
    log?.info?.(
      `WhatsApp: PIX ${key.id} liberado para /count${backfill.length ? ` (${backfill.length} reacao(oes) existente(s))` : ''}.`,
    );
  } catch (err) {
    log?.warn?.(`WhatsApp: falha ao registrar PIX para /count: ${err.message}`);
  }
}

/** @deprecated hub centralizado no servidor — mantido para compatibilidade */
export async function prepareRunWhatsAppNotices({ log } = {}) {
  return { ready: true, reason: 'hub-centralized' };
}

/** @deprecated comandos ficam no hub do servidor */
export async function attachBotWhatsAppCommands({ log } = {}) {
  return { ready: false, reason: 'hub-centralized' };
}

/** Aviso no grupo quando o bot inicia. */
export async function sendRunStartedToGroup({ log } = {}) {
  return sendTextToGroup({ text: '🤖 grokPix iniciado', log, urgent: true });
}

/** Aviso no grupo quando o bot para (finalizado ou interrompido). */
export async function sendRunFinishedToGroup({ interrupted = false, log, groupId } = {}) {
  const text = interrupted ? '⏹ grokPix parado' : '✅ grokPix finalizado';
  return sendTextToGroup({ text, log, urgent: true, groupId });
}

const WA_TEXT_CHUNK = 3500;

/** Formata contas prontas no padrao email|senha| */
export function formatReadyAccountLines(accounts = []) {
  const lines = [];
  for (const a of accounts) {
    const email = String(a?.email || '').trim();
    const password = String(a?.password || '').trim();
    if (!email || !password) continue;
    const credential = String(a?.credential || '').trim();
    lines.push(credential || `${email}|${password}|`);
  }
  return lines;
}

/**
 * Envia contas prontas do PIX no grupo WhatsApp (ao finalizar/parar o ativador).
 * Parte em varias mensagens se passar do limite do WhatsApp.
 */
export async function sendReadyPixAccountsToGroup({
  accounts = [],
  interrupted = false,
  log,
  force = false,
  groupId,
} = {}) {
  if (!config.whatsappEnabled) {
    return { sent: false, reason: 'disabled', count: 0 };
  }
  if (!force && !config.whatsappSendReadyPixOnStop) {
    return { sent: false, reason: 'config-off', count: 0 };
  }

  const lines = formatReadyAccountLines(accounts);
  if (!lines.length) {
    log?.info?.('WhatsApp: nenhuma conta pronta PIX para enviar.');
    return { sent: false, reason: 'empty', count: 0 };
  }

  const head = interrupted
    ? `✅ Contas prontas PIX desta run (parado) — ${lines.length}`
    : `✅ Contas prontas PIX desta run — ${lines.length}`;

  const chunks = [];
  let buf = `${head}\n\n`;
  for (const line of lines) {
    if (buf.length + line.length + 1 > WA_TEXT_CHUNK) {
      chunks.push(buf.trimEnd());
      buf = `${line}\n`;
    } else {
      buf += `${line}\n`;
    }
  }
  if (buf.trim()) chunks.push(buf.trimEnd());

  let sent = 0;
  let lastReason = null;
  for (let i = 0; i < chunks.length; i++) {
    const text =
      chunks.length > 1 ? `${chunks[i]}\n\n(${i + 1}/${chunks.length})` : chunks[i];
    // urgent: usa o socket do bot (avisos), nao a fila do hub pausado no servidor.
    const result = await sendTextToGroup({ text, log, urgent: true, groupId });
    if (result?.sent === false) {
      lastReason = result.reason || 'send-failed';
      log?.warn?.(`WhatsApp contas PIX falhou (parte ${i + 1}): ${lastReason}`);
      break;
    }
    sent += 1;
  }

  if (sent > 0) {
    log?.info?.(
      `WhatsApp: ${lines.length} conta(s) pronta(s) PIX enviada(s) no grupo (${sent} msg).`,
    );
    return { sent: true, count: lines.length, messages: sent };
  }
  return { sent: false, reason: lastReason || 'send-failed', count: lines.length };
}

/** @deprecated use sendReadyPixAccountsToGroup */
export async function sendGeneratedAccountsToGroup(opts = {}) {
  return sendReadyPixAccountsToGroup({
    ...opts,
    accounts: opts.accounts || opts.results || [],
  });
}

/** Legenda WhatsApp: somente o codigo PIX copia-e-cola. */
function buildPixCaption({ copyPaste }) {
  return String(copyPaste || '').trim();
}

async function sendViaEvolution({ text, qrImagePath, log }) {
  const { evolutionApiUrl, evolutionApiKey, evolutionInstance, whatsappGroupId } = config;
  if (!evolutionApiUrl || !evolutionInstance || !whatsappGroupId) {
    throw new Error('Evolution API incompleta (URL, INSTANCE ou GROUP_ID).');
  }

  const base = evolutionApiUrl.replace(/\/$/, '');
  const headers = {
    'Content-Type': 'application/json',
    apikey: evolutionApiKey || '',
  };

  const textUrl = `${base}/message/sendText/${encodeURIComponent(evolutionInstance)}`;

  if (qrImagePath && fs.existsSync(qrImagePath)) {
    const mediaUrl = `${base}/message/sendMedia/${encodeURIComponent(evolutionInstance)}`;
    const b64 = fs.readFileSync(qrImagePath).toString('base64');
    const mediaRes = await fetch(mediaUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        number: whatsappGroupId,
        mediatype: 'image',
        media: b64,
        caption: text,
      }),
    });
    if (!mediaRes.ok) {
      const body = await mediaRes.text().catch(() => '');
      throw new Error(`Evolution sendMedia HTTP ${mediaRes.status}: ${body.slice(0, 200)}`);
    }
    log?.info?.('WhatsApp: QR + legenda em 1 mensagem (Evolution).');
  } else {
    const textRes = await fetch(textUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ number: whatsappGroupId, text }),
    });
    if (!textRes.ok) {
      const body = await textRes.text().catch(() => '');
      throw new Error(`Evolution sendText HTTP ${textRes.status}: ${body.slice(0, 200)}`);
    }
    log?.info?.('WhatsApp: texto enviado ao grupo.');
  }

  return { sent: true, provider: 'evolution' };
}

async function sendViaWebhook({ text, copyPaste, qrImagePath, email, log }) {
  const url = config.whatsappWebhookUrl;
  if (!url) throw new Error('WHATSAPP_WEBHOOK_URL ausente.');

  let qrBase64 = null;
  if (qrImagePath && fs.existsSync(qrImagePath)) {
    qrBase64 = fs.readFileSync(qrImagePath).toString('base64');
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'grokpix',
      email,
      text,
      copyPaste,
      qrImagePath,
      qrBase64,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Webhook HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  log?.info?.('WhatsApp: payload enviado via webhook.');
  return { sent: true, provider: 'webhook' };
}
