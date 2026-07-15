import qrcode from 'qrcode';
import { config } from '../../bot/shared/config.js';
import {
  clearBaileysAuth,
  connectBaileysWithQr,
  getBaileysSessionStatus,
  hasSavedSession,
  pauseBaileysHub,
  resumeBaileysHub,
  setBaileysLoginUiActive,
} from '../../bot/shared/whatsapp/whatsappBaileys.js';
import { sleep } from '../../bot/shared/browser/pageHelpers.js';
import { getWhatsAppHubStatus, refreshWhatsAppHub } from './whatsappHub.js';
import { getEnvMap } from './settingsStore.js';
import { listGroups } from './groupStore.js';

const apiLog = {
  info: (msg) => console.log(`[whatsapp-login-ui] ${msg}`),
  warn: (msg) => console.warn(`[whatsapp-login-ui] ${msg}`),
  debug: () => {},
};

const loginState = {
  phase: 'idle',
  qrDataUrl: null,
  message: '',
  error: null,
  startedAt: null,
};

let loginPromise = null;

function snapshotLogin() {
  return {
    phase: loginState.phase,
    qrDataUrl: loginState.qrDataUrl,
    message: loginState.message,
    error: loginState.error,
    startedAt: loginState.startedAt,
    inProgress: !!loginPromise,
  };
}

export function isWhatsAppLoginInProgress() {
  return !!loginPromise;
}

export function getWhatsAppUiStatus() {
  const session = getBaileysSessionStatus();
  const hub = getWhatsAppHubStatus();
  const env = getEnvMap();

  return {
    session,
    hub,
    login: snapshotLogin(),
    settings: {
      whatsappEnabled: envBool(env.WHATSAPP_ENABLED, true),
      commandsEnabled: envBool(env.WHATSAPP_COMMANDS_ENABLED, true),
      commandsPublic: envBool(env.WHATSAPP_COMMANDS_PUBLIC, true),
      adminPhones: String(env.WHATSAPP_ADMIN_PHONES || '').trim(),
      sendReadyPixOnStop: envBool(env.WHATSAPP_SEND_READY_PIX_ON_STOP, false),
    },
    registeredGroups: listGroups().length,
    authDir: config.whatsappAuthDir,
  };
}

function envBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase());
}

export async function startWhatsAppQrLogin({ force = true } = {}) {
  if (loginPromise) {
    return snapshotLogin();
  }

  loginState.phase = 'connecting';
  loginState.qrDataUrl = null;
  loginState.message = 'Preparando conexao...';
  loginState.error = null;
  loginState.startedAt = new Date().toISOString();

  setBaileysLoginUiActive(true);
  apiLog.info(force ? 'Iniciando login QR (sessao limpa)...' : 'Iniciando login QR...');

  pauseBaileysHub(apiLog);
  await sleep(800);

  if (force || hasSavedSession()) {
    if (hasSavedSession()) {
      apiLog.warn('Apagando sessao antiga:', config.whatsappAuthDir);
    }
    clearBaileysAuth();
  }

  loginPromise = connectBaileysWithQr({
    log: apiLog,
    timeoutMs: 600000,
    onQr: async (qr) => {
      loginState.phase = 'qr';
      loginState.message = 'Escaneie o QR no celular (WhatsApp > Dispositivos conectados).';
      loginState.error = null;
      try {
        loginState.qrDataUrl = await qrcode.toDataURL(qr, { width: 400, margin: 2 });
        apiLog.info('QR gerado — aguardando escaneamento.');
      } catch (err) {
        loginState.error = err.message;
      }
    },
  })
    .then(async () => {
      loginState.phase = 'connected';
      loginState.qrDataUrl = null;
      loginState.message = 'WhatsApp conectado com sucesso.';
      loginState.error = null;
      setBaileysLoginUiActive(false);
      resumeBaileysHub();
      await refreshWhatsAppHub();
      apiLog.info('Login QR concluido — hub atualizado.');
    })
    .catch((err) => {
      loginState.phase = 'error';
      loginState.error = err.message;
      loginState.message = 'Falha no login — use Novo QR ou Desconectar e tente de novo.';
      loginState.qrDataUrl = null;
      setBaileysLoginUiActive(false);
      resumeBaileysHub();
      apiLog.warn(`Login QR falhou: ${err.message}`);
    })
    .finally(() => {
      loginPromise = null;
    });

  return snapshotLogin();
}

export async function cancelWhatsAppQrLogin() {
  setBaileysLoginUiActive(false);
  pauseBaileysHub(apiLog);
  if (hasSavedSession()) {
    clearBaileysAuth();
  }
  loginPromise = null;
  loginState.phase = 'idle';
  loginState.qrDataUrl = null;
  loginState.message = 'Login cancelado.';
  loginState.error = null;
  resumeBaileysHub();
  await refreshWhatsAppHub().catch(() => {});
  return snapshotLogin();
}

export async function disconnectWhatsAppSession() {
  await cancelWhatsAppQrLogin();
  loginState.message = 'Sessao removida. Conecte novamente com QR.';
  return getWhatsAppUiStatus();
}

export async function reconnectWhatsAppHub() {
  if (isWhatsAppLoginInProgress()) {
    throw new Error('Login em andamento — aguarde ou cancele.');
  }
  resumeBaileysHub();
  await refreshWhatsAppHub();
  return getWhatsAppUiStatus();
}
