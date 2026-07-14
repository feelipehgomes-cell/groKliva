import { config } from '../../bot/shared/config.js';

import {

  warmBaileysHub,

  attachBaileysCommandListener,

  attachBaileysReactionListener,

  normalizeGroupJid,

  onBaileysSocketReady,

  onBaileysSocketLost,

  isBaileysLoginUiActive,

  getBaileysSessionStatus,

} from '../../bot/shared/whatsapp/whatsappBaileys.js';

import { handleServerWhatsAppCommand } from '../../bot/shared/whatsapp/whatsappCommandHandler.js';

import { listGroups } from './groupStore.js';



const hubLog = {

  info: (msg) => console.log(`[whatsapp-hub] ${msg}`),

  warn: (msg) => console.warn(`[whatsapp-hub] ${msg}`),

  debug: () => {},

};



let hubStarting = false;

let hubConnected = false;

let retryTimer = null;

let hubSocket = null;

const HUB_HEALTH_MS = 90_000;

let healthTimer = null;



function canRunHub() {

  return (

    config.whatsappEnabled &&

    config.whatsappProvider === 'baileys' &&

    config.whatsappCommandsEnabled

  );

}



function enabledGroupJids() {

  return listGroups({ enabledOnly: true }).map((g) => normalizeGroupJid(g.id));

}

function enabledGroupSummary() {

  return listGroups({ enabledOnly: true }).map((g) => `${g.label} (${g.id})`);

}



function attachHubListeners(sock) {

  const groupJids = enabledGroupJids();

  if (!groupJids.length) return;

  attachBaileysCommandListener(sock, {

    groupJids,

    log: hubLog,

    onCommand: (command, ctx) => handleServerWhatsAppCommand(command, ctx),

  });

  attachBaileysReactionListener(sock, { groupJids, log: hubLog });

}



function scheduleHubRetry(ms = 12_000) {

  if (retryTimer) return;

  retryTimer = setTimeout(() => {

    retryTimer = null;

    startWhatsAppHub();

  }, ms);

}



onBaileysSocketReady((sock) => {

  if (!canRunHub()) return;

  hubSocket = sock;

  hubConnected = true;

  attachHubListeners(sock);

  hubLog.info(

    `Socket pronto — comandos em ${enabledGroupJids().length} grupo(s): ${enabledGroupSummary().join('; ')}`,

  );

});



onBaileysSocketLost((reason) => {

  hubConnected = false;

  hubSocket = null;

  if (reason) hubLog.warn(`WhatsApp desconectou (${reason}) — reconectando hub...`);

  scheduleHubRetry(8_000);

});



function startHubHealthWatch() {

  if (healthTimer) return;

  healthTimer = setInterval(() => {

    if (!canRunHub() || isBaileysLoginUiActive()) return;

    const status = getBaileysSessionStatus();

    if (!status.hasSession) return;

    if (status.hubPaused) return;

    if (status.connected && status.hasCommandListener) {

      hubConnected = true;

      return;

    }

    hubLog.warn(

      'WhatsApp hub inativo (sem socket ou listener) — reconectando...',

    );

    hubConnected = false;

    hubSocket = null;

    startWhatsAppHub().catch(() => {});

  }, HUB_HEALTH_MS);

}



export async function startWhatsAppHub() {

  if (!canRunHub()) return;

  startHubHealthWatch();

  if (isBaileysLoginUiActive()) {
    hubLog.warn('Login QR em andamento — hub aguardando.');
    scheduleHubRetry(15_000);
    return;
  }



  const groupJids = enabledGroupJids();

  if (!groupJids.length) {

    hubLog.warn('Nenhum grupo WhatsApp cadastrado — hub aguardando grupos.');

    scheduleHubRetry(30_000);

    return;

  }



  if (hubStarting) return;



  hubStarting = true;

  try {

    const { sock } = await warmBaileysHub({ log: hubLog, groupJids });

    hubSocket = sock;

    hubConnected = true;

    attachHubListeners(sock);

    hubLog.info(

      `Comandos ativos em ${groupJids.length} grupo(s): ${enabledGroupSummary().join('; ')}. Use /start /stop /status /count`,

    );

  } catch (err) {

    hubConnected = false;

    hubSocket = null;

    hubLog.warn(`Falha ao iniciar hub: ${err.message}`);

    scheduleHubRetry();

  } finally {

    hubStarting = false;

  }

}



export async function refreshWhatsAppHub() {

  hubConnected = false;

  if (hubSocket && hubSocket.user?.id) {

    try {

      attachHubListeners(hubSocket);

      hubConnected = true;

      hubLog.info(

        `Hub atualizado: comandos em ${enabledGroupJids().length} grupo(s) ativo(s).`,

      );

      return;

    } catch (err) {

      hubLog.warn(`Falha ao atualizar hub: ${err.message}`);

    }

  }

  await startWhatsAppHub();

}



export function getHubSocket() {

  return hubSocket;

}

export function getWhatsAppHubStatus() {
  const groups = listGroups({ enabledOnly: true });
  return {
    connected: hubConnected,
    starting: hubStarting,
    enabledGroupCount: groups.length,
    enabledGroups: groups.map((g) => ({ id: g.id, label: g.label })),
    commandsEnabled: config.whatsappCommandsEnabled,
    whatsappEnabled: config.whatsappEnabled,
    canRun: canRunHub(),
  };
}



/** @deprecated hub nao e mais pausado com multi-grupo */

export async function pauseWhatsAppHub() {

  /* noop — socket permanece no servidor */

}



/** @deprecated */

export function resumeWhatsAppHub() {

  if (!hubConnected) startWhatsAppHub().catch(() => {});

}

