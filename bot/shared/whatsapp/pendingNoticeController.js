import { getPaidEmails } from '../pix/paidStore.js';
import { isConfirmedPixMessage, waMessageId } from './reactionCountStore.js';

/**
 * Controla envio de "pendente ⏱️" no WhatsApp.
 * Bloqueia reply em PIX ja pago (email em paid-emails ou mensagem confirmada).
 * Pendente pode ser reenviado a cada ciclo de espera ate o pagamento.
 */

const paidKeys = new Set();

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeEmv(copyPaste) {
  return String(copyPaste || '').trim();
}

function messageKeyId(waMessage) {
  return waMessageId(waMessage?.key) || waMessageId(waMessage) || null;
}

/** Chaves estaveis para bloqueio (email, EMV, id da msg WA). */
export function pendingNoticeKeys({ email, copyPaste, waMessage } = {}) {
  const keys = [];
  const em = normalizeEmail(email);
  const emv = normalizeEmv(copyPaste);
  const msgId = messageKeyId(waMessage);
  if (em) keys.push(`email:${em}`);
  if (emv) keys.push(`emv:${emv}`);
  if (msgId) keys.push(`wa:${msgId}`);
  return keys;
}

export function markPixPaidForPending({ email, copyPaste, waMessage } = {}) {
  for (const key of pendingNoticeKeys({ email, copyPaste, waMessage })) {
    paidKeys.add(key);
  }
}

function isMarkedPaid(keys) {
  return keys.some((k) => paidKeys.has(k));
}

function isEmailPaidOnDisk(email) {
  const em = normalizeEmail(email);
  if (!em) return false;
  return getPaidEmails().has(em);
}

function isWaMessageConfirmed(waMessage) {
  const key = waMessage?.key;
  if (!key?.id) return false;
  return isConfirmedPixMessage(key);
}

/**
 * Decide se pode enviar "pendente ⏱️".
 * @returns {{ allow: boolean, reason?: string }}
 */
export function shouldSendPendingNotice({ email, copyPaste, waMessage } = {}) {
  const keys = pendingNoticeKeys({ email, copyPaste, waMessage });

  if (isMarkedPaid(keys)) {
    return { allow: false, reason: 'pix-ja-pago-memoria' };
  }

  if (isEmailPaidOnDisk(email)) {
    markPixPaidForPending({ email, copyPaste, waMessage });
    return { allow: false, reason: 'email-ja-pago' };
  }

  if (isWaMessageConfirmed(waMessage)) {
    markPixPaidForPending({ email, copyPaste, waMessage });
    return { allow: false, reason: 'pix-ja-confirmado-whatsapp' };
  }

  return { allow: true };
}

/** Limpa estado em memoria (ex.: inicio de nova run). */
export function resetPendingNoticeController() {
  paidKeys.clear();
}
