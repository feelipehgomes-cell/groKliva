import { config, assertConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import {
  loadAccounts,
  saveResults,
  removeAccountsFromFile,
} from '../shared/accounts/accounts.js';
import {
  createPool,
  summarizeExtended,
  formatRunSummaryLines,
  formatSubscribeStuckSummaryLines,
  effectiveConcurrency,
} from '../shared/pool.js';
import { effectiveInstanceStaggerMs } from '../shared/proxy/proxy.js';
import { formatActiveSubscribeLines } from '../shared/whatsapp/subscribeActivity.js';
import { excludePaidAccounts, getPaidEmails } from '../shared/pix/paidStore.js';
import { assertPayerResultsAvailable, summarizePayerResults } from '../shared/pix/payerStore.js';
import { killStaleChromeFromProfiles } from '../shared/browser/browser.js';
import { installGracefulInterrupt } from '../shared/gracefulShutdown.js';
import {
  sendRunStartedToGroup,
  sendRunFinishedToGroup,
} from '../shared/whatsapp/whatsapp.js';
import { resetPendingNoticeController } from '../shared/whatsapp/pendingNoticeController.js';

const WA_FINISH_TIMEOUT_MS = 25000;
const WA_INTERRUPT_TIMEOUT_MS = 5000;
const WA_SEND_READY_TIMEOUT_MS = 45000;
const INTERRUPT_POOL_DRAIN_MS = 12000;

export function parseActivateArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, val] = m;
    out[key] = val === undefined ? true : val;
  }
  return out;
}

/**
 * Envia contas prontas do PIX no grupo (somente se o toggle do grupo estiver ativo).
 * Sempre pelo processo do bot (Baileys local) — a API do KLIVA falha com
 * "hub pausado" enquanto o ativador ainda esta rodando.
 * Envia somente contas desta run (nao o estoque acumulado).
 */
async function notifyReadyPixAccounts({
  interrupted = false,
  log = logger,
  runResults = [],
  baselinePaidEmails = null,
} = {}) {
  if (!config.whatsappSendReadyPixOnStop) {
    return { sent: false, reason: 'config-off' };
  }

  const send = async () => {
    const { sendReadyPixAccountsToGroup } = await import('../shared/whatsapp/whatsapp.js');
    const { accountsReadyFromRunDelta, listReadyAccounts, markReadyAccountsReleased } =
      await import('../../server/services/readyAccountsStore.js');
    const { getPaidCredentials } = await import('../shared/pix/paidStore.js');
    const passwordMap = new Map();
    for (const [email, password] of getPaidCredentials()) {
      if (email && password) passwordMap.set(email, password);
    }

    const groupSlug = config.klivaGroupSlug || null;

    // Pagamento confirmado na run + diff paid-emails.txt (workers podem nao ter fechado a tempo)
    let accounts = accountsReadyFromRunDelta({
      runResults,
      passwordMap,
      baselinePaidEmails,
      groupSlug,
    });

    // Fallback: results.json do grupo (paymentConfirmed) ainda nao liberadas
    if (!accounts.length && baselinePaidEmails) {
      accounts = listReadyAccounts('activate', passwordMap, groupSlug).filter(
        (a) => !baselinePaidEmails.has(String(a.email).toLowerCase()),
      );
    }

    if (!accounts.length) {
      const paidNow = getPaidEmails().size;
      const baselineSize = baselinePaidEmails?.size ?? 0;
      log.info(
        `WhatsApp: nenhuma conta paga nova desta run (pool: ${runResults.length}, paid: ${baselineSize}->${paidNow}).`,
      );
      return { sent: false, reason: 'empty', count: 0 };
    }

    const result = await sendReadyPixAccountsToGroup({
      accounts,
      interrupted,
      log,
      force: true,
      groupId: config.klivaGroupId,
    });
    if (result?.sent) {
      const mark = markReadyAccountsReleased(
        'activate',
        accounts.map((a) => a.email),
        passwordMap,
        config.klivaGroupSlug || null,
      );
      result.released = mark.released;
    }
    return result;
  };

  try {
    const result = await Promise.race([
      send(),
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              sent: false,
              reason: `timeout ${WA_SEND_READY_TIMEOUT_MS / 1000}s`,
            }),
          WA_SEND_READY_TIMEOUT_MS,
        ),
      ),
    ]);
    if (result?.sent) {
      log.summary(
        `WhatsApp: ${result.count ?? '?'} conta(s) pronta(s) PIX enviada(s) no grupo.`,
      );
    } else if (
      result?.reason &&
      result.reason !== 'config-off' &&
      result.reason !== 'empty'
    ) {
      log.warn(`WhatsApp contas PIX nao enviadas: ${result.reason}`);
    }
    return result;
  } catch (err) {
    log.warn(`WhatsApp contas PIX falhou: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

async function sendRunFinishedNotice({ interrupted, log, groupId }) {
  const wa = await Promise.race([
    sendRunFinishedToGroup({ interrupted, log, groupId }),
    new Promise((r) =>
      setTimeout(() => r({ sent: false, reason: `timeout ${WA_FINISH_TIMEOUT_MS / 1000}s` }), WA_FINISH_TIMEOUT_MS),
    ),
  ]);
  if (wa.sent) {
    log.summary(
      interrupted ? 'WhatsApp: KLIVA parado enviado' : 'WhatsApp: KLIVA finalizado enviado',
    );
  } else if (wa.reason !== 'disabled') {
    log.warn(`WhatsApp fim nao enviado: ${wa.reason}`);
  }
  return wa;
}

export function applyActivateArgs(args = {}) {
  if (args.concurrency != null && args.concurrency !== true) {
    const n = parseInt(String(args.concurrency), 10);
    if (!Number.isNaN(n) && n >= 1) config.concurrency = n;
  }
  if (args.accounts) config.accountsFile = args.accounts;
  if (args['group-id']) {
    config.klivaGroupId = String(args['group-id']);
    config.whatsappGroupId = config.klivaGroupId;
  }
  if (process.env.KLIVA_GROUP_SLUG) {
    config.klivaGroupSlug = process.env.KLIVA_GROUP_SLUG;
  }
  if (args.headful) config.headless = false;
  config.subscribeTrial = true;
  if (args['simple-logs']) config.simpleLogs = true;
  if (args['verbose-logs']) config.simpleLogs = false;

  const loginUseProxy = args.proxy
    ? true
    : args['no-proxy']
      ? false
      : config.loginUseProxy;
  if (!loginUseProxy) {
    config.proxyUrl = '';
    if (!config.simpleLogs) {
      logger.info('Proxy DESLIGADA para o login (conexao direta).');
    }
  } else if (!config.proxyUrl) {
    logger.warn(
      'PIX_USE_PROXY=true mas PROXY_URL vazia — rodando sem proxy (mesmo IP em todas as instancias).',
    );
  }

  return args;
}

/**
 * @param {{ args?: object, onProgress?: Function }} opts
 */
export async function runActivateBot(opts = {}) {
  const args = applyActivateArgs(opts.args || {});

  assertConfig();

  if (config.payerResultsFile) {
    try {
      assertPayerResultsAvailable();
      const pay = summarizePayerResults();
      if (!config.simpleLogs) {
        logger.info(
          `Pagadores PIX: ${pay.blocks.length} resultado(s), ${pay.totalSlots} vaga(s) (${pay.cap} contas/resultado) — ${config.payerResultsFile}`,
        );
      }
    } catch (err) {
      throw err;
    }
  }

  killStaleChromeFromProfiles(logger);
  resetPendingNoticeController();

  // Snapshot do estoque no inicio — ao parar so envia o que entrou nesta run.
  const baselinePaidEmails = new Set(getPaidEmails());

  const paidOnDisk = baselinePaidEmails;
  if (paidOnDisk.size) {
    const purged = await removeAccountsFromFile([...paidOnDisk]);
    if (purged > 0) {
      logger.info(
        `Removido(s) ${purged} email(s) ja pago(s) de ${config.accountsFile}.`,
      );
    }
  }

  let accounts = loadAccounts(config.accountsFile);

  const skipPaid =
    config.skipPaidAccounts && !args['no-skip-paid'] && !args['include-paid'];
  if (skipPaid) {
    const before = accounts.length;
    accounts = excludePaidAccounts(accounts);
    const skipped = before - accounts.length;
    if (skipped > 0) {
      logger.info(
        `Pulando ${skipped} conta(s) ja paga(s) (${config.paidEmailsFile}).`,
      );
    }
  }

  const limitRaw = args.limit ?? config.activateAccountLimit;
  const limit = parseInt(String(limitRaw), 10);
  if (Number.isFinite(limit) && limit > 0 && accounts.length > limit) {
    logger.info(`Limite de contas: ${limit} de ${accounts.length}.`);
    accounts = accounts.slice(0, limit);
  } else if (Number.isFinite(limit) && limit > 0) {
    logger.info(`Limite de contas: ${limit} (fila tem ${accounts.length}).`);
  }

  if (!accounts.length) {
    throw new Error(
      skipPaid
        ? 'Nenhuma conta pendente (todas ja pagas ou arquivo vazio).'
        : 'Nenhuma conta carregada. Verifique o arquivo de contas.',
    );
  }

  const activeSlots = effectiveConcurrency(accounts.length, config.concurrency);
  const concLabel =
    activeSlots < config.concurrency
      ? `conc ${config.concurrency} (${activeSlots} ativas${config.proxyUrl && config.loginUseProxy ? `, cap proxy ${config.proxyMaxConcurrency}` : ''})`
      : `conc ${config.concurrency}`;

  if (config.simpleLogs) {
    const stagger = effectiveInstanceStaggerMs();
    const groupLabel = config.klivaGroupSlug || config.klivaGroupId || 'default';
    logger.summary(
      `KLIVA | ${groupLabel} | ${accounts.length} contas | ${concLabel} | proxy: ${config.proxyUrl ? 'on' : 'off'} | pix: on | stagger: ${stagger}ms | janelas: ${config.hideWindows ? 'fora' : 'visiveis'} | wa prontas: ${config.whatsappSendReadyPixOnStop ? 'on' : 'off'}`,
    );
  } else {
    logger.info('==============================================');
    logger.info(` KLIVA - ativacao PIX em ${accounts.length} conta(s)`);
    if (config.klivaGroupId) logger.info(` grupo: ${config.klivaGroupId}`);
    logger.info(` concorrencia: ${config.concurrency} (${activeSlots} instancia(s) ativa(s))`);
    logger.info(` stagger: ${effectiveInstanceStaggerMs()}ms`);
    logger.info(` janelas fora da tela: ${config.hideWindows}`);
    logger.info(` manter browser aberto: ${config.keepBrowserOpen}`);
    logger.info(` headless: ${config.headless}`);
    logger.info(` proxy: ${config.proxyUrl ? 'on' : 'off'}`);
    logger.info(` whatsapp: ${config.whatsappEnabled ? config.whatsappProvider : 'disabled'}`);
    logger.info(
      ` whatsapp contas prontas ao parar: ${config.whatsappSendReadyPixOnStop ? 'on' : 'off'}`,
    );
    logger.info(
      ` modo pix: ${config.waitForPixPayment ? 'aguardar pagamento confirmado' : config.releaseBrowserAfterPixSend ? 'rapido (sem confirmar)' : 'hold browser'}`,
    );
    logger.info('==============================================');
  }

  const started = Date.now();

  const pool = createPool(accounts, {
    concurrency: config.concurrency,
  });
  let interruptHandled = false;

  if (config.whatsappEnabled) {
    try {
      if (process.env.KLIVA_SKIP_WA_START_NOTICE !== '1') {
        const wa = await sendRunStartedToGroup({ log: logger, groupId: config.klivaGroupId });
        if (!wa.sent && wa.reason !== 'disabled') {
          logger.warn(`WhatsApp inicio nao enviado: ${wa.reason}`);
        }
      }
    } catch (e) {
      logger.warn(`WhatsApp inicio: ${e.message}`);
    }
  }

  const heartbeatMs = 45000;
  const heartbeat = setInterval(() => {
    for (const line of formatActiveSubscribeLines()) {
      logger.summary(line);
    }
  }, heartbeatMs);

  const stopHeartbeat = () => {
    clearInterval(heartbeat);
  };

  const finalizeRun = async ({ interrupted = false, skipWhatsapp = false } = {}) => {
    stopHeartbeat();

    if (config.whatsappEnabled && !skipWhatsapp) {
      try {
        await sendRunFinishedNotice({ interrupted, log: logger, groupId: config.klivaGroupId });
      } catch (e) {
        logger.warn(`WhatsApp fim: ${e.message}`);
      }
    }

    const stats = summarizeExtended(pool.results);
    const pending = Math.max(0, accounts.length - stats.total);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    let file = config.resultsFile;
    try {
      file = saveResults(pool.results);
    } catch {
      /* ignore */
    }

    console.log('');
    for (const line of formatRunSummaryLines(stats, { interrupted, pending })) {
      logger.summary(`${line} | ${elapsed}s`);
    }
    for (const line of formatSubscribeStuckSummaryLines(pool.results)) {
      logger.summary(line);
    }
    logger.summary(`Resultados: ${file}`);

    opts.onProgress?.({ stats, results: pool.results, file, interrupted });

    await notifyReadyPixAccounts({
      interrupted,
      log: logger,
      runResults: pool.results,
      baselinePaidEmails,
    });

    return { stats, file, elapsed, results: pool.results };
  };

  const onInterrupt = async () => {
    if (interruptHandled) return;
    interruptHandled = true;
    stopHeartbeat();

    logger.summary('Interrompendo — encerrando instancias...');
    pool.abort();
    killStaleChromeFromProfiles(logger, { force: true });

    await Promise.race([
      pool.wait(),
      new Promise((resolve) => setTimeout(resolve, INTERRUPT_POOL_DRAIN_MS)),
    ]);

    if (config.whatsappEnabled) {
      try {
        const wa = await Promise.race([
          sendRunFinishedNotice({ interrupted: true, log: logger, groupId: config.klivaGroupId }),
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ sent: false, reason: `timeout ${WA_INTERRUPT_TIMEOUT_MS / 1000}s` }),
              WA_INTERRUPT_TIMEOUT_MS,
            ),
          ),
        ]);
        if (!wa.sent && wa.reason !== 'disabled') {
          logger.warn(`WhatsApp parado NAO enviado: ${wa.reason}`);
        }
      } catch (e) {
        logger.warn(`WhatsApp parado: ${e.message}`);
      }
    }

    await finalizeRun({ interrupted: true, skipWhatsapp: true });
    process.exit(130);
  };

  installGracefulInterrupt(onInterrupt);

  await pool.wait();

  const stats = summarizeExtended(pool.results);
  const result = await finalizeRun({ interrupted: false });

  if (config.keepBrowserOpen && stats.ok > 0) {
    interruptHandled = false;
    logger.info('KEEP_BROWSER_OPEN=true -> pressione Ctrl+C para encerrar.');
    await new Promise(() => {});
    return { ...result, exitCode: 0, keepOpen: true };
  }

  interruptHandled = true;
  const exitCode = stats.loginFail > 0 || stats.pixFail > 0 ? 2 : 0;
  return { ...result, exitCode };
}
