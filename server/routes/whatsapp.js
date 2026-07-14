import { Router } from 'express';
import {
  sendPixToGroup,
  sendTextToGroup,
  replyPendingToPixMessage,
  sendConfirmationToGroup,
  sendReadyPixAccountsToGroup,
} from '../../bot/shared/whatsapp/whatsapp.js';
import { getGroupById, groupSendReadyPixEnabled } from '../services/groupStore.js';
import { getEnvMap } from '../services/settingsStore.js';
import { getDashboard, markCopiedReadyAccounts } from '../services/dataStore.js';
import {
  cancelWhatsAppQrLogin,
  disconnectWhatsAppSession,
  getWhatsAppUiStatus,
  reconnectWhatsAppHub,
  startWhatsAppQrLogin,
} from '../services/whatsappLoginManager.js';

const router = Router();

const apiLog = {
  info: (msg) => console.log(`[whatsapp-api] ${msg}`),
  warn: (msg) => console.warn(`[whatsapp-api] ${msg}`),
  debug: () => {},
  error: (msg) => console.error(`[whatsapp-api] ${msg}`),
};

function envBool(key) {
  const raw = getEnvMap()[key];
  if (raw === undefined || raw === null || raw === '') return null;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase());
}

function isSendReadyPixOnStopEnabled(groupId = null) {
  if (groupId && getGroupById(groupId)) {
    return groupSendReadyPixEnabled(groupId);
  }
  const next = envBool('WHATSAPP_SEND_READY_PIX_ON_STOP');
  if (next !== null) return next;
  return envBool('WHATSAPP_SEND_GENERATED_ON_STOP') === true;
}

router.get('/status', (_req, res) => {
  res.json(getWhatsAppUiStatus());
});

router.post('/login/start', async (req, res) => {
  try {
    const force = req.body?.force !== false;
    const login = await startWhatsAppQrLogin({ force });
    res.json({ ok: true, login, ...getWhatsAppUiStatus() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, ...getWhatsAppUiStatus() });
  }
});

router.post('/login/cancel', async (_req, res) => {
  try {
    const login = await cancelWhatsAppQrLogin();
    res.json({ ok: true, login, ...getWhatsAppUiStatus() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/disconnect', async (_req, res) => {
  try {
    const status = await disconnectWhatsAppSession();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/hub/reconnect', async (_req, res) => {
  try {
    const status = await reconnectWhatsAppHub();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/send-text', async (req, res) => {
  try {
    const { groupId, text, urgent } = req.body || {};
    if (!groupId) return res.status(400).json({ ok: false, error: 'groupId obrigatorio' });
    const result = await sendTextToGroup({ groupId, text, log: apiLog, urgent: !!urgent });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/send-pix', async (req, res) => {
  try {
    const { groupId, email, copyPaste, qrImagePath, cpf } = req.body || {};
    if (!groupId) return res.status(400).json({ ok: false, error: 'groupId obrigatorio' });
    const result = await sendPixToGroup({
      groupId,
      email,
      copyPaste,
      qrImagePath,
      cpf,
      log: apiLog,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/reply-pending', async (req, res) => {
  try {
    const { groupId, copyPaste, waMessage, email } = req.body || {};
    if (!groupId) return res.status(400).json({ ok: false, error: 'groupId obrigatorio' });
    const result = await replyPendingToPixMessage({
      groupId,
      copyPaste,
      waMessage,
      email,
      log: apiLog,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/reply-confirmation', async (req, res) => {
  try {
    const { groupId, copyPaste, waMessage, text, email, count } = req.body || {};
    if (!groupId) return res.status(400).json({ ok: false, error: 'groupId obrigatorio' });
    const result = await sendConfirmationToGroup({
      groupId,
      copyPaste,
      waMessage,
      text,
      email,
      count,
      log: apiLog,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

async function handleSendReadyPix(req, res) {
  try {
    const interrupted = Boolean(req.body?.interrupted);
    const groupId = req.body?.groupId || null;

    if (!isSendReadyPixOnStopEnabled(groupId)) {
      return res.json({ ok: true, sent: false, reason: 'config-off', count: 0 });
    }

    const onlyEmails = Array.isArray(req.body?.emails)
      ? new Set(
          req.body.emails
            .map((e) => String(e || '').trim().toLowerCase())
            .filter(Boolean),
        )
      : null;

    const dash = getDashboard();
    let accounts = groupId
      ? (dash.groups || []).find((g) => g.id === groupId)?.readyActivate || []
      : dash.readyActivate || [];
    if (onlyEmails?.size) {
      accounts = accounts.filter((a) => onlyEmails.has(String(a.email).toLowerCase()));
    }

    const result = await sendReadyPixAccountsToGroup({
      accounts,
      interrupted,
      log: apiLog,
      force: true,
      groupId,
    });

    let released = 0;
    if (result?.sent) {
      const mark = markCopiedReadyAccounts(
        'activate',
        accounts.map((a) => a.email),
        groupId,
      );
      released = mark.released;
      if (released > 0) {
        apiLog.info(
          `${released} conta(s) PIX removida(s) da lista de prontas apos envio WhatsApp.`,
        );
      }
    }

    res.json({ ok: true, ...result, released });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}

router.post('/send-ready-pix', handleSendReadyPix);
router.post('/send-generated', handleSendReadyPix);

export default router;
