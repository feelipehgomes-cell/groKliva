import { config } from './config.js';
import { logger } from './logger.js';
import { saveResults, isSubscribePhaseFailure } from './accounts/accounts.js';
import { runAccount } from '../activate/worker.js';
import { sleep } from './browser/pageHelpers.js';
import { formatActiveSubscribeLines } from './whatsapp/subscribeActivity.js';
import { effectiveConcurrencyLimit, effectiveInstanceStaggerMs, isProxyActive } from './proxy/proxy.js';

/**
 * Pool cancelavel — expoe results parciais e abort() para Ctrl+C.
 * @returns {{ results: object[], abort: () => void, wait: () => Promise<void> }}
 */
export function effectiveConcurrency(accountCount, concurrency = config.concurrency) {
  return effectiveConcurrencyLimit(concurrency, accountCount);
}

export function createPool(accounts, { concurrency = config.concurrency, onAccountDone } = {}) {
  const total = accounts.length;
  const limit = effectiveConcurrency(total, concurrency);
  const results = [];
  let nextIndex = 0;
  let launched = 0;
  let done = 0;
  let aborted = false;

  if (!config.simpleLogs) {
    const proxyNote = isProxyActive() && limit < concurrency ? ` (cap proxy ${config.proxyMaxConcurrency})` : '';
    logger.info(`Pool: ${total} conta(s), ${limit} instancia(s) simultanea(s)${proxyNote}.`);
  }

  const staggerMs = effectiveInstanceStaggerMs();

  async function worker(slotId) {
    while (!aborted) {
      const idx = nextIndex++;
      if (idx >= total) break;

      const account = accounts[idx];

      if (staggerMs > 0 && launched < limit) {
        await sleep(staggerMs * launched);
      }
      launched++;

      let result;
      try {
        result = await runAccount(account, { workerId: `S${slotId}.${idx + 1}` });
      } catch (err) {
        logger.error(`Conta ${account.email} erro inesperado: ${err.message}`);
        result = {
          email: account.email,
          ok: false,
          reason: `erro: ${err.message}`,
          at: new Date().toISOString(),
        };
      }
      results.push(result);
      done++;
      if (!config.simpleLogs) {
        logger.info(`Progresso: ${done}/${total} concluidas.`);
      }

      if (onAccountDone) {
        try {
          await onAccountDone(result);
        } catch (e) {
          logger.debug('onAccountDone falhou:', e.message);
        }
      }

      try {
        const toSave = config.klivaGroupId
          ? results.map((r) => ({ ...r, groupId: r.groupId || config.klivaGroupId }))
          : results;
        saveResults(toSave);
      } catch (e) {
        logger.debug('falha ao salvar results:', e.message);
      }
    }
  }

  const slots = [];
  for (let s = 1; s <= limit; s++) slots.push(worker(s));

  const wait = Promise.all(slots);

  return {
    results,
    total,
    abort: () => {
      aborted = true;
    },
    wait: () => wait,
  };
}

/**
 * Executa uma lista de contas com no maximo `concurrency` instancias simultaneas.
 * @param {Array} accounts
 * @param {object} opts - { concurrency }
 * @returns {Promise<Array>} resultados
 */
export async function runPool(accounts, opts = {}) {
  const pool = createPool(accounts, opts);
  await pool.wait();
  return pool.results;
}

export function summarize(results) {
  const ok = results.filter((r) => r && r.ok).length;
  const fail = results.length - ok;
  return { total: results.length, ok, fail };
}

export function summarizeExtended(results) {
  const base = summarize(results);
  const loginOk = results.filter((r) => r?.ok === true).length;
  const loginFail = results.filter((r) => r?.ok === false).length;
  const withTrial = results.filter((r) => r?.trialDetected === true).length;
  const noTrial = results.filter((r) => r?.ok === true && r?.trialDetected === false).length;
  const pixOk = results.filter((r) => r?.pixSubscribed === true).length;
  const pixFail = results.filter(
    (r) => r?.trialDetected === true && r?.pixSubscribed === false,
  ).length;

  return {
    ...base,
    loginOk,
    loginFail,
    withTrial,
    noTrial,
    trial: withTrial,
    pixOk,
    pixFail,
  };
}

/** Contas com login+trial ok mas travadas ou falharam no subscribe (pre-PIX ou Stripe). */
export function listSubscribeStuckAccounts(results) {
  return (results || []).filter(
    (r) =>
      r?.ok === true &&
      r?.trialDetected === true &&
      r?.pixSubscribed === false &&
      (isSubscribePhaseFailure(r?.subscribeReason) ||
        (r.subscribeAttempts ?? 0) > 0 ||
        (r.subscribeGrokErrors ?? 0) > 0),
  );
}

export function formatSubscribeStuckSummaryLines(results) {
  const stuck = listSubscribeStuckAccounts(results);
  const activeLines = formatActiveSubscribeLines();
  if (!stuck.length && !activeLines.length) return [];

  const lines = [];
  if (activeLines.length) lines.push(...activeLines);
  if (stuck.length) {
    lines.push(`subscribe preso/falhou: ${stuck.length} conta(s)`);
    for (const r of stuck) {
      lines.push(
        `  ${r.email} | cliques plano: ${r.subscribeAttempts ?? 0} | erros Grok: ${r.subscribeGrokErrors ?? 0} | rodada worker: ${r.attempt ?? 1} | ${r.subscribeReason || '?'}`,
      );
    }
  }
  return lines;
}

/** Linhas de resumo para final normal ou Ctrl+C. */
export function formatRunSummaryLines(stats, { interrupted = false, pending = 0 } = {}) {
  const head = interrupted ? 'INTERROMPIDO' : 'CONCLUIDO';
  const lines = [
    `${head} | processadas: ${stats.total}${pending > 0 ? ` | pendentes: ${pending}` : ''}`,
    `login OK: ${stats.loginOk} | login falhou: ${stats.loginFail}`,
    `com trial: ${stats.withTrial} | sem trial: ${stats.noTrial}`,
  ];
  if (config.subscribeTrial) {
    lines.push(`PIX OK: ${stats.pixOk} | PIX falhou: ${stats.pixFail}`);
  }
  return lines;
}
