import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { saveResults } from '../shared/accounts/accounts.js';
import { killStaleChromeFromProfiles } from '../shared/browser/browser.js';
import { initEmailDomains } from '../shared/accounts/generatorEmail.js';
import { installGracefulInterrupt } from '../shared/gracefulShutdown.js';
import { generateAccount } from './worker.js';
import { sleep } from '../shared/browser/pageHelpers.js';

export function parseGenerateArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, val] = m;
    out[key] = val === undefined ? true : val;
  }
  return out;
}

export function applyGenerateArgs(args = {}) {
  const count = parseInt(args.count, 10) || config.generateCount;
  if (args.concurrency != null && args.concurrency !== true) {
    const n = parseInt(String(args.concurrency), 10);
    if (!Number.isNaN(n) && n >= 1) config.concurrency = n;
  }
  if (args.headful) config.headless = false;

  const generateUseProxy = args.proxy ? true : args['no-proxy'] ? false : config.generateUseProxy;
  if (!generateUseProxy) {
    config.proxyUrl = '';
    logger.info('Proxy DESLIGADA para o gerador (conexao direta).');
  }

  return { count };
}

function createGeneratePool(count, concurrency, onProgress) {
  const limit = Math.max(1, Math.min(concurrency, count));
  const results = [];
  let next = 0;
  let launched = 0;
  let done = 0;
  let aborted = false;

  logger.info(`Pool: gerando ${count} conta(s), ${limit} instancia(s) simultanea(s).`);

  async function worker(slotId) {
    while (!aborted) {
      const idx = next++;
      if (idx >= count) break;

      if (config.instanceStaggerMs > 0 && launched < limit) {
        await sleep(config.instanceStaggerMs * launched);
      }
      launched++;

      const result = await generateAccount({ workerId: `G${slotId}.${idx + 1}` });
      results.push(result);
      done++;
      logger.info(`Progresso: ${done}/${count} concluida(s).`);
      onProgress?.({ done, total: count, results: [...results] });

      try {
        saveResults(results, config.generatedResultsFile);
      } catch (e) {
        logger.debug('falha ao salvar resultados:', e.message);
      }
    }
  }

  const slots = [];
  for (let s = 1; s <= limit; s++) slots.push(worker(s));

  return {
    results,
    abort: () => {
      aborted = true;
    },
    wait: () => Promise.all(slots),
  };
}

/**
 * @param {{ count?: number, concurrency?: number, args?: object, onProgress?: Function }} opts
 */
export async function runGenerateBot(opts = {}) {
  const args = opts.args || {};
  const { count } = applyGenerateArgs(args);

  if (config.concurrency < 1) {
    throw new Error('CONCURRENCY deve ser >= 1.');
  }

  killStaleChromeFromProfiles(logger);

  logger.info('==============================================');
  logger.info(` KLIVA - GERADOR de contas (${count} conta(s))`);
  logger.info(` concorrencia: ${config.concurrency}`);
  logger.info(` headless: ${config.headless}`);
  logger.info(` proxy: ${config.proxyUrl ? 'on' : 'off'}`);
  logger.info(` email: modo ${config.email.mode}`);
  logger.info('==============================================');

  const started = Date.now();
  let pool = null;
  let interruptHandled = false;

  const onInterrupt = async () => {
    if (interruptHandled) return;
    interruptHandled = true;
    logger.summary('Interrompendo gerador...');
    pool?.abort();
    killStaleChromeFromProfiles(logger, { force: true });

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const results = pool?.results || [];
    const ok = results.filter((r) => r && r.ok).length;
    const fail = results.length - ok;
    const pending = Math.max(0, count - results.length);
    let file = config.generatedResultsFile;
    if (results.length) {
      try {
        file = saveResults(results, config.generatedResultsFile);
      } catch {
        /* ignore */
      }
    }
    logger.summary(
      `INTERROMPIDO em ${elapsed}s | criadas: ${ok} | falhas: ${fail} | processadas: ${results.length}${pending > 0 ? ` | pendentes: ${pending}` : ''}`,
    );
    if (results.length) logger.summary(`Resultados: ${file}`);
    process.exit(130);
  };

  installGracefulInterrupt(onInterrupt);

  logger.info('Carregando dominios do generator.email...');
  const domains = await initEmailDomains();
  logger.info(
    `Dominios disponiveis: ${domains.length} (${domains.slice(0, 5).join(', ')}${domains.length > 5 ? '...' : ''})`,
  );

  pool = createGeneratePool(count, config.concurrency, opts.onProgress);

  await pool.wait();
  const results = pool.results;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const ok = results.filter((r) => r && r.ok).length;
  const fail = results.length - ok;
  const file = saveResults(results, config.generatedResultsFile);

  logger.info('==============================================');
  logger.info(` Concluido em ${elapsed}s`);
  logger.info(` Criadas: ${ok} | Falhas: ${fail} | Total: ${results.length}`);
  logger.info(` Contas salvas em: ${config.generatedAccountsFile}`);
  logger.info(` Resultados: ${file}`);
  logger.info('==============================================');

  interruptHandled = true;
  return { results, ok, fail, elapsed, file, exitCode: fail > 0 && ok === 0 ? 2 : 0 };
}
