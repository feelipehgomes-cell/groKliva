import { config } from '../shared/config.js';
import { createLogger, formatAccountSummary } from '../shared/logger.js';
import { getInstanceProxy, maskProxy, verifyProxyWithRetry, isConnectionError, isBrowserConnected } from '../shared/proxy/proxy.js';
import { launchBrowser, setupPage, closeBrowserForced, clearAuthStorage, parseWindowSlot, focusPage } from '../shared/browser/browser.js';
import { loginGrok } from '../shared/grok/grokLogin.js';
import { subscribeTrialPix } from '../shared/grok/grokSubscribe.js';
import { waitForPixGone } from '../shared/pix/pixExtract.js';
import { getPayerData } from '../shared/pix/payer.js';
import { sendPixToGroup, sendConfirmationToGroup, replyPendingToPixMessage } from '../shared/whatsapp/whatsapp.js';
import {
  removeAccountsFromFile,
  isInvalidLoginCredentials,
  isNoTrialSubscribeFailure,
} from '../shared/accounts/accounts.js';
import { registerPaid } from '../shared/pix/paidStore.js';
import { sleep, prepareEmailLoginPage } from '../shared/browser/pageHelpers.js';
import { subscribeActivityUpdate } from '../shared/whatsapp/subscribeActivity.js';

/**
 * Roda o login de UMA conta em uma instancia isolada de browser.
 * Cada worker: gera proxy dedicada, sobe browser, faz login, fecha tudo.
 *
 * @param {object} account - { email, password, index, ... }
 * @param {object} opts - { workerId }
 * @returns {Promise<object>} resultado
 */
export async function runAccount(account, { workerId } = {}) {
  const browserRef = { current: null };
  const baseTimeoutMs = config.accountTimeoutMs;

  if (!(baseTimeoutMs > 0)) {
    return runAccountInner(account, { workerId }, browserRef);
  }

  let resolveTimeout;
  let timeoutTimer;
  const timeoutResult = new Promise((resolve) => {
    resolveTimeout = resolve;
  });

  const armAccountTimeout = (ms) => {
    clearTimeout(timeoutTimer);
    if (!(ms > 0)) return;
    timeoutTimer = setTimeout(
      () => resolveTimeout({ __accountTimeout: true, ms }),
      ms,
    );
  };

  armAccountTimeout(baseTimeoutMs);

  const timeoutHooks = {
    /** PIX enviado — estende ou desliga timeout para nao fechar antes do pagamento. */
    onPixWaitingPayment: () => {
      if (config.releaseBrowserAfterPixSend && !config.waitForPixPayment) {
        const checkMs = Math.max(15000, config.pixPostSendCheckMs || 45000);
        armAccountTimeout(checkMs + 90000);
        return;
      }
      if (config.waitForPixPayment && config.paymentWaitMaxCycles === 0) {
        clearTimeout(timeoutTimer);
        return;
      }
      const holdMs = Math.max(config.pixBrowserHoldMs, 180000);
      const cycleMs = Math.max(30000, config.paymentWaitCycleMs || 300000);
      const paymentMs = config.waitForPixPayment
        ? cycleMs * Math.max(1, config.paymentWaitMaxCycles || 12) + 120000
        : holdMs + 60000;
      armAccountTimeout(paymentMs);
    },
  };

  const result = await Promise.race([
    runAccountInner(account, { workerId }, browserRef, timeoutHooks),
    timeoutResult,
  ]);
  clearTimeout(timeoutTimer);

  if (result?.__accountTimeout) {
    const tag = `#${workerId ?? account.index} ${account.email}`;
    const log = createLogger(tag);
    log.error(
      `Timeout da conta (${Math.round(result.ms / 1000)}s) — fechando instancia para liberar slot.`,
    );
    await closeBrowserForced(browserRef.current, log, {
      cleanupProfile: config.chromeFreshProfile,
      fast: true,
    });
    return finishAccount(log, {
      email: account.email,
      ok: false,
      reason: `timeout conta ${Math.round(result.ms / 1000)}s`,
      proxy: null,
      attempt: 1,
      at: new Date().toISOString(),
    });
  }

  return result;
}

async function runAccountInner(
  account,
  { workerId } = {},
  browserRef = { current: null },
  timeoutHooks = {},
) {
  const tag = `#${workerId ?? account.index} ${account.email}`;
  const log = createLogger(tag);

  const maxRetries = Math.max(0, config.maxRetriesPerAccount);
  let lastResult = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) log.warn(`Retry ${attempt}/${maxRetries}...`);

    // sessao/IP novo a cada tentativa (evita reusar um IP de proxy que caiu)
    const proxy = getInstanceProxy({ seed: `${workerId}-${account.email}-${attempt}` });
    if (!config.simpleLogs) {
      log.info(
        `Iniciando. Proxy: ${maskProxy(proxy)}${proxy?.sessionId ? ` (session ${proxy.sessionId})` : ''}`,
      );
    } else if (proxy) {
      log.debug(`Proxy session ${proxy.sessionId || '-'}`);
    }

    let browser;
    let publicIp = null;
    try {
      const launchStart = Date.now();
      browser = await launchBrowser({
        proxy,
        log,
        profileKey: `${workerId}-${account.email}-${attempt}`,
        windowSlot: parseWindowSlot(workerId),
      });
      if (!config.simpleLogs) {
        log.info(`Chrome aberto em ${Date.now() - launchStart}ms`);
      }
      browserRef.current = browser;
      const page = await setupPage(browser, { proxy, log });
      await focusPage(page, log);
      if (proxy && config.proxyVerifyOnStart) {
        const tunnel = await verifyProxyWithRetry(page, log).catch((e) => ({
          ok: false,
          reason: e.message,
        }));
        if (!tunnel.ok) {
          throw new Error(`proxy: ${tunnel.reason || 'HTTPS indisponivel'}`);
        }
      }
      if (!browser.__profileWasFresh) {
        await clearAuthStorage(page, log);
      }
      await prepareEmailLoginPage(page, config.selectors.emailInput, { log });

      const started = Date.now();
      const result = await loginGrok(page, account, {
        proxy,
        log,
        freshProfile: browser.__profileWasFresh,
      });
      const durationMs = Date.now() - started;

      lastResult = {
        email: account.email,
        password: account.password,
        ok: result.ok,
        reason: result.reason,
        url: result.url,
        trialDetected: result.trialDetected ?? null,
        invalidCredentials: !!(result.invalidCredentials || isInvalidLoginCredentials(result.reason)),
        proxy: maskProxy(proxy),
        publicIp,
        durationMs,
        attempt: attempt + 1,
        at: new Date().toISOString(),
      };

      if (result.ok) {
        log.info(`SUCESSO em ${durationMs}ms (${result.reason}).`);

        if (config.subscribeTrial) {
          if (result.trialDetected === false) {
            log.warn('Sem trial na home nem em #subscribe — descartando conta.');
            await removeAccountFromList(account.email, 'Sem trial disponivel', log);
          } else {
            await runSubscribeFlow(page, account, lastResult, log, browser, workerId, timeoutHooks);

            if (lastResult.paymentConfirmed) {
              if (!config.keepBrowserOpen) {
                await closeBrowserForced(browser, log, {
                  cleanupProfile: config.chromeFreshProfile,
                  fast: false,
                });
              }
              browserRef.current = null;
              return finishAccount(log, lastResult);
            }

            if (
              isNoTrialSubscribeFailure(lastResult.subscribeReason) &&
              !/checkout stripe/i.test(String(lastResult.subscribeReason))
            ) {
              await removeAccountFromList(account.email, 'Sem trial disponivel', log);
            }
          }
        } else if (result.trialDetected === false) {
          log.warn('Login ok mas trial nao apareceu — use conta NOVA (trial e so na 1a vez).');
          await removeAccountFromList(account.email, 'Sem trial disponivel', log);
        }

        if (config.keepBrowserOpen) {
          log.info('KEEP_BROWSER_OPEN=true -> mantendo browser aberto.');
          return finishAccount(log, lastResult);
        }
        await closeBrowserForced(browser, log, {
          cleanupProfile: config.chromeFreshProfile,
          fast: !lastResult.paymentConfirmed,
        });
        browserRef.current = null;
        return finishAccount(log, lastResult);
      }

      log.warn(`FALHA: ${result.reason}`);
      await closeBrowserForced(browser, log, { cleanupProfile: config.chromeFreshProfile });
      browserRef.current = null;

      if (lastResult.invalidCredentials) {
        await removeAccountFromList(account.email, 'Email/senha invalidos', log);
        break;
      }
    } catch (err) {
      const conn = isConnectionError(err.message);
      const nav = /execution context was destroyed|context was destroyed|detached Frame|acquireContextId failed|No frame with given id/i.test(err.message || '');
      if (conn) {
        log.warn(
          `Erro de conexao — fechando instancia (retry ${attempt + 1}/${maxRetries + 1}): ${err.message}`,
        );
      } else if (nav) {
        log.warn(`Navegacao durante login (proxy lenta) — retry ${attempt + 1}/${maxRetries + 1}`);
      } else {
        log.error(`Erro na instancia: ${err.message}`);
      }
      lastResult = {
        email: account.email,
        password: account.password,
        ok: false,
        reason: conn ? `conexao: ${err.message}` : `erro: ${err.message}`,
        proxy: maskProxy(proxy),
        publicIp,
        attempt: attempt + 1,
        at: new Date().toISOString(),
      };
      await closeBrowserForced(browser, log, { cleanupProfile: config.chromeFreshProfile });
      browserRef.current = null;
    }

    if (attempt < maxRetries) await sleep(800);
  }

  return finishAccount(log, lastResult);
}

function finishAccount(log, result) {
  if (config.simpleLogs && result) {
    log.summary(formatAccountSummary(result));
  }
  return result;
}

async function removeAccountFromList(email, reason, log) {
  const removed = await removeAccountsFromFile([email]);
  if (removed > 0) {
    log.info(`${reason} — removido de ${config.accountsFile}.`);
  }
}

async function runSubscribeFlow(
  page,
  account,
  lastResult,
  log,
  browser,
  workerId = '',
  timeoutHooks = {},
) {
  try {
    const sub = await subscribeTrialPix(page, account, { log, browser, workerId });
    lastResult.pixSubscribed = sub.ok;
    lastResult.subscribeReason = sub.reason;
    lastResult.subscribeAttempts = sub.subscribeAttempts ?? 0;
    lastResult.subscribeGrokErrors = sub.subscribeGrokErrors ?? 0;

    if (!sub.ok) {
      log.warn(`Assinatura PIX falhou: ${sub.reason}`);
      logSubscribeStuckSummary(log, account.email, lastResult, sub.reason);
      if (isNoTrialSubscribeFailure(sub.reason) && !/checkout stripe/i.test(String(sub.reason))) {
        await removeAccountFromList(account.email, 'Sem trial (CTA nao encontrado)', log);
      }
      return;
    }

    lastResult.pixCopyPaste = sub.pix?.copyPaste ?? null;
    lastResult.qrImagePath = sub.pix?.qrImagePath ?? null;
    log.info('PIX extraido.' + (sub.pix?.copyPaste ? ' (copia-e-cola ok)' : ' (so QR/imagem)'));

    const payer = sub.payer || (await getPayerData(account));
    const pixMsg = {
      email: account.email,
      copyPaste: sub.pix?.copyPaste,
      qrImagePath: sub.pix?.qrImagePath,
      cpf: payer.cpf,
      log,
    };

    const wa = await sendPixToGroupSafe(pixMsg, log);
    pixMsg.waMessage = wa.waMessage ?? null;
    lastResult.whatsappSent = wa.sent === true;
    if (!wa.sent) lastResult.whatsappReason = wa.reason;

    if (config.releaseBrowserAfterPixSend && !config.waitForPixPayment && wa.sent) {
      log.warn(
        'Modo rapido ativo — confirmação de pagamento limitada a checagem curta (RELEASE_BROWSER_AFTER_PIX).',
      );
      subscribeActivityUpdate(account.email, { phase: 'checagem pagamento' });
      timeoutHooks?.onPixWaitingPayment?.();
      await quickPostSendPaymentCheck(page, pixMsg, account, lastResult, log, browser);
      return;
    }

    log.info('PIX enviado — aguardando pagamento confirmado no browser...');
    await monitorPixPaymentAfterSend(
      page,
      pixMsg,
      account,
      lastResult,
      log,
      browser,
      timeoutHooks,
    );
  } catch (err) {
    lastResult.pixSubscribed = lastResult.pixSubscribed ?? false;
    lastResult.subscribeReason = err.message;
    log.error(`Erro no fluxo subscribe: ${err.message}`);
    logSubscribeStuckSummary(log, account.email, lastResult, err.message);
    if (
      isNoTrialSubscribeFailure(err.message) &&
      !/checkout stripe/i.test(String(err.message))
    ) {
      await removeAccountFromList(account.email, 'Sem trial (CTA nao encontrado)', log);
    }
  }
}

async function incrementGroupMarcador(log) {
  if (!config.klivaGroupId) return null;
  try {
    const port = config.klivaPort || 4000;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/groups/${encodeURIComponent(config.klivaGroupId)}/stats/increment`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body.stats?.activatedCount ?? null;
  } catch (err) {
    log?.warn?.(`Marcador PIX nao incrementado: ${err.message}`);
    return null;
  }
}

async function markPaymentConfirmed(account, pixMsg, lastResult, log) {
  const total = await registerPaid(account.email, account.password);
  lastResult.paymentConfirmed = true;
  lastResult.pixSubscribed = true;
  lastResult.ok = true;
  lastResult.reason = 'pagamento confirmado';
  lastResult.paidCount = total;
  log.info(`Pagamento confirmado! Total cumulativo: ${total}`);

  const marcador = await incrementGroupMarcador(log);

  const { markPixPaidForPending } = await import('../shared/whatsapp/pendingNoticeController.js');
  markPixPaidForPending({
    email: account.email,
    copyPaste: pixMsg.copyPaste,
    waMessage: pixMsg.waMessage,
  });

  const conf = await sendConfirmationToGroupSafe(
    {
      email: account.email,
      count: marcador ?? '?',
      copyPaste: pixMsg.copyPaste,
      waMessage: pixMsg.waMessage,
      log,
    },
    log,
  );
  lastResult.confirmationSent = conf.sent === true;
  if (!conf.sent) lastResult.confirmationReason = conf.reason;
}

/**
 * Checagem curta de pagamento antes de liberar o browser (modo rapido).
 */
async function quickPostSendPaymentCheck(page, pixMsg, account, lastResult, log, browser) {
  const checkMs = Math.max(15000, config.pixPostSendCheckMs || 45000);
  log.info(`Aguardando ate ${Math.round(checkMs / 1000)}s por pagamento instantaneo...`);
  try {
    const result = await waitForPixGone(page, { browser, log, timeoutMs: checkMs });
    if (result.paid) {
      await markPaymentConfirmed(account, pixMsg, lastResult, log);
      return;
    }
  } catch (err) {
    if (!isConnectionError(err.message)) throw err;
    log.warn(`Checagem rapida interrompida: ${err.message}`);
  }
  log.info('Slot liberado — pagamento pode continuar no grupo WhatsApp.');
}

/**
 * Mantem o browser aberto monitorando pagamento do QR no Stripe.
 * So libera a instancia apos pagamento confirmado ou tempo maximo.
 */
async function monitorPixPaymentAfterSend(
  page,
  pixMsg,
  account,
  lastResult,
  log,
  browser,
  timeoutHooks = {},
) {
  if (config.keepBrowserOpen) return;

  subscribeActivityUpdate(account.email, { phase: 'aguardando pagamento' });
  timeoutHooks?.onPixWaitingPayment?.();

  if (config.waitForPixPayment) {
    log.info('Aguardando pagamento no browser (WAIT_FOR_PIX_PAYMENT=true)...');
    const paid = await waitForPaymentLoop(page, pixMsg, log, browser);
    if (paid) {
      await markPaymentConfirmed(account, pixMsg, lastResult, log);
    } else {
      log.warn('Pagamento nao confirmado no browser — PIX continua no grupo WhatsApp.');
    }
    return;
  }

  const holdMs = Math.max(config.pixBrowserHoldMs, 300000);
  const deadline = Date.now() + holdMs;
  log.info(
    `Aguardando pagamento do QR — browser aberto ate ${Math.round(holdMs / 1000)}s (PIX_BROWSER_HOLD_MS).`,
  );

  while (Date.now() < deadline) {
    if (browser && !(await isBrowserConnected(browser))) {
      log.warn('Browser desconectado durante espera do pagamento.');
      return;
    }

    const remaining = deadline - Date.now();
    const chunkMs = Math.min(30000, remaining);
    if (chunkMs <= 0) break;

    let result;
    try {
      result = await waitForPixGone(page, { browser, log, timeoutMs: chunkMs });
    } catch (err) {
      if (isConnectionError(err.message)) {
        log.warn(`Erro na espera do PIX — liberando instancia: ${err.message}`);
        return;
      }
      throw err;
    }

    if (result.paid) {
      await markPaymentConfirmed(account, pixMsg, lastResult, log);
      return;
    }
  }

  log.warn('Tempo de espera esgotado — QR nao pago; respondendo pendente no PIX existente...');
  await replyPendingToPixMessageSafe(pixMsg, log);
}

function logSubscribeStuckSummary(log, email, result, reason) {
  const planClicks = result?.subscribeAttempts ?? 0;
  const grokErrors = result?.subscribeGrokErrors ?? 0;
  const workerRound = result?.attempt ?? 1;
  const label =
    planClicks > 0 || grokErrors > 0 ? 'SUBSCRIBE PRESO' : 'SUBSCRIBE FALHA';
  log.summary(
    `${label}: ${email} | ${reason || '?'} | cliques plano: ${planClicks} | erros Grok: ${grokErrors} | rodada worker: ${workerRound}/${(config.maxRetriesPerAccount ?? 0) + 1}`,
  );
}

async function sendPixToGroupSafe(pixMsg, log) {
  try {
    return await sendPixToGroup(pixMsg);
  } catch (waErr) {
    if (config.whatsappFailSoft) {
      log.warn(`WhatsApp falhou (nao bloqueia): ${waErr.message}`);
      return { sent: false, reason: waErr.message };
    }
    throw waErr;
  }
}

async function sendConfirmationToGroupSafe(msg, log) {
  try {
    return await sendConfirmationToGroup(msg);
  } catch (waErr) {
    if (config.whatsappFailSoft) {
      log.warn(`Confirmacao WhatsApp falhou: ${waErr.message}`);
      return { sent: false, reason: waErr.message };
    }
    throw waErr;
  }
}

async function replyPendingToPixMessageSafe(pixMsg, log) {
  try {
    return await replyPendingToPixMessage({
      email: pixMsg.email,
      copyPaste: pixMsg.copyPaste,
      waMessage: pixMsg.waMessage,
      log,
    });
  } catch (waErr) {
    if (config.whatsappFailSoft) {
      log.warn(`WhatsApp pendente falhou (nao bloqueia): ${waErr.message}`);
      return { sent: false, reason: waErr.message };
    }
    throw waErr;
  }
}

/**
 * Aguarda o QR fechar (= pagamento). A cada ciclo sem pagamento, responde
 * "pendente ⏱️" na mensagem PIX existente (nao reenvia QR).
 * @returns {Promise<boolean>} true se pagamento detectado
 */
async function waitForPaymentLoop(page, pixMsg, log, browser) {
  const cycleMs = Math.max(300000, config.paymentWaitCycleMs);
  const maxCycles = config.paymentWaitMaxCycles;
  log.info(
    `Aguardando pagamento (ciclo de ${Math.round(cycleMs / 1000)}s${maxCycles > 0 ? `, max ${maxCycles} ciclo(s)` : ''})...`,
  );
  let cycles = 0;
  for (;;) {
    if (browser && !(await isBrowserConnected(browser))) {
      log.warn('Browser desconectado — liberando instancia (PIX ja enviado no grupo).');
      return false;
    }

    let result;
    try {
      result = await waitForPixGone(page, { browser, log, timeoutMs: cycleMs });
    } catch (err) {
      if (isConnectionError(err.message)) {
        log.warn(`Erro de conexao na espera do PIX — liberando instancia: ${err.message}`);
        return false;
      }
      throw err;
    }

    if (result.paid) {
      const { markPixPaidForPending } = await import('../shared/whatsapp/pendingNoticeController.js');
      markPixPaidForPending({
        email: pixMsg.email,
        copyPaste: pixMsg.copyPaste,
        waMessage: pixMsg.waMessage,
      });
      return true;
    }
    // Browser morto (ex.: /stop matou o Chrome) NAO e "ciclo sem pagamento" —
    // liberar sem responder "pendente" no PIX do grupo.
    if (result.reason === 'browser-disconnected') {
      log.warn('Browser desconectado — liberando instancia sem enviar pendente.');
      return false;
    }
    cycles += 1;
    if (maxCycles > 0 && cycles >= maxCycles) {
      log.warn(`Limite de ${maxCycles} ciclo(s) sem pagamento — liberando browser.`);
      return false;
    }
    log.info(`QR nao pago apos ${cycles} ciclo(s) — respondendo pendente no PIX existente...`);
    const pending = await replyPendingToPixMessageSafe(pixMsg, log);
    if (pending?.sent) {
      log.info(`WhatsApp: pendente ⏱️ enviado (ciclo ${cycles}).`);
    } else if (pending?.blocked) {
      if (
        pending.reason === 'email-ja-pago' ||
        pending.reason === 'pix-ja-confirmado-whatsapp' ||
        pending.reason === 'pix-ja-pago-memoria'
      ) {
        log.info(`PIX ja pago (${pending.reason}) — tratando como confirmado.`);
        return true;
      }
      log.warn(`Pendente nao enviado (${pending.reason}).`);
    }
  }
}