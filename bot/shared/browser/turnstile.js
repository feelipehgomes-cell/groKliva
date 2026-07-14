import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { config, ROOT_DIR } from '../config.js';
import { isProxyActive } from '../proxy/proxy.js';
import {
  hasTurnstile,
  hasTurnstileToken,
  turnstileLooksSolved,
  hasTurnstileFrame,
  nudgeTurnstile,
  waitForTurnstileSolved,
  sleep,
  wakePage,
} from '../browser/pageHelpers.js';

const require = createRequire(import.meta.url);
const solvers = new WeakMap();
let checkTurnstileCached = undefined;
let foregroundTurnstileChain = Promise.resolve();

/** Carrega checkTurnstile do puppeteer-real-browser (subpath nao esta no package exports). */
async function getCheckTurnstile(log) {
  if (checkTurnstileCached !== undefined) return checkTurnstileCached;

  const esmPath = path.join(
    ROOT_DIR,
    'node_modules/puppeteer-real-browser/lib/esm/module/turnstile.mjs',
  );
  try {
    const mod = await import(pathToFileURL(esmPath).href);
    if (mod.checkTurnstile) {
      checkTurnstileCached = mod.checkTurnstile;
      return checkTurnstileCached;
    }
  } catch (e) {
    log?.debug?.('checkTurnstile ESM falhou:', e.message);
  }

  try {
    const cjsPath = path.join(
      ROOT_DIR,
      'node_modules/puppeteer-real-browser/lib/cjs/module/turnstile.js',
    );
    const mod = require(cjsPath);
    if (mod.checkTurnstile) {
      checkTurnstileCached = mod.checkTurnstile;
      return checkTurnstileCached;
    }
  } catch (e) {
    log?.warn?.('Turnstile solver indisponivel:', e.message);
  }

  checkTurnstileCached = null;
  return null;
}

function isAuthUrl(url) {
  return /accounts\.x\.ai|x\.ai\/sign|grok\.com/i.test(url || '');
}

function isStripeUrl(url) {
  return /checkout\.stripe\.com|stripe\.com\/c\/pay/i.test(url || '');
}

async function clickTurnstile(page, log) {
  const checkTurnstile = await getCheckTurnstile(log);
  if (checkTurnstile) {
    await checkTurnstile({ page }).catch(() => {});
    return true;
  }
  await nudgeTurnstile(page);
  return false;
}

/**
 * So uma janela pode ficar "na frente" por vez no Windows/Chrome.
 * Se varias instancias tentam resolver Turnstile juntas, uma rouba o foco da outra
 * e o Cloudflare tende a reprovar. Serializamos a fase ativa de resolucao.
 */
async function withForegroundTurnstileLock(task) {
  const prev = foregroundTurnstileChain;
  let release = () => {};
  foregroundTurnstileChain = new Promise((resolve) => {
    release = resolve;
  });
  await prev.catch(() => {});
  try {
    return await task();
  } finally {
    release();
  }
}

/**
 * Solver controlado — so roda em paginas de auth E quando o widget Turnstile existe.
 * O turnstile:true do puppeteer-real-browser clica em divs ~300px a cada 1s em QUALQUER
 * pagina (incl. Stripe), roubando foco dos inputs e fechando o QR PIX.
 */
export function startBackgroundTurnstileSolver(page, log) {
  if (!page || solvers.has(page)) return;

  let running = true;
  const run = async () => {
    const checkTurnstile = await getCheckTurnstile(log);
    if (!checkTurnstile) return;

    log?.debug?.('Turnstile solver ativo (somente em paginas de login).');

    while (running) {
      try {
        const url = page.url();
        if (isStripeUrl(url) || !isAuthUrl(url)) {
          await sleep(isProxyActive() ? 700 : 1000);
          continue;
        }

        if (await hasTurnstileToken(page)) {
          await sleep(isProxyActive() ? 900 : 1500);
          continue;
        }

        const present =
          (await hasTurnstile(page).catch(() => false)) || hasTurnstileFrame(page);
        if (present) {
          if ((await hasTurnstileToken(page)) || (await turnstileLooksSolved(page))) {
            await sleep(isProxyActive() ? 700 : 1000);
            continue;
          }
          await wakePage(page);
          await checkTurnstile({ page }).catch(() => {});
          await waitForTurnstileSolved(page, { timeout: 1500 }).catch(() => null);
        }
      } catch {
        /* pagina fechada ou navegando */
      }
      await sleep(isProxyActive() ? 700 : 1000);
    }
  };

  solvers.set(page, () => {
    running = false;
  });
  run();
}

export function stopBackgroundTurnstileSolver(page, log) {
  const stop = solvers.get(page);
  if (!stop) return;
  stop();
  solvers.delete(page);
  log?.debug?.('Turnstile solver pausado.');
}

async function detectTurnstile(page, { waitMs = 2500, poll = 150 } = {}) {
  const start = Date.now();
  let nudged = false;
  while (Date.now() - start < waitMs) {
    const visible = await hasTurnstile(page).catch(() => false);
    if (visible || hasTurnstileFrame(page)) return true;
    if (!nudged && Date.now() - start > 600) {
      await nudgeTurnstile(page);
      nudged = true;
    }
    await sleep(poll);
  }
  return false;
}

/**
 * Resolve Turnstile clicando no widget (checkTurnstile) ate o token aparecer.
 */
export async function solveTurnstileIfPresent(page, { log, waitMs = 2500 } = {}) {
  if (await hasTurnstileToken(page)) {
    log?.debug?.('Turnstile ja resolvido (token presente).');
    return { solved: true, token: 'present', skipped: false };
  }

  if (await turnstileLooksSolved(page)) {
    await waitForTurnstileSolved(page, { timeout: isProxyActive() ? 350 : 500 }).catch(() => null);
    if ((await hasTurnstileToken(page)) || (await turnstileLooksSolved(page))) {
      log?.debug?.('Turnstile ja resolvido (UI Sucesso).');
      return { solved: true, token: 'present', skipped: false };
    }
  }

  const present = await detectTurnstile(page, { waitMs });
  if (!present) {
    log?.debug?.('Nenhum Turnstile detectado, seguindo.');
    return { solved: true, token: null, skipped: true };
  }

  if ((await hasTurnstileToken(page)) || (await turnstileLooksSolved(page))) {
    return { solved: true, token: 'present', skipped: false };
  }

  return withForegroundTurnstileLock(async () => {
    if (await hasTurnstileToken(page)) {
      return { solved: true, token: 'present', skipped: false };
    }

    await wakePage(page);
    await nudgeTurnstile(page);

    const deadline = Date.now() + (isProxyActive() ? 20000 : 25000);
    while (Date.now() < deadline) {
      if (await hasTurnstileToken(page)) {
        log?.info?.('Turnstile resolvido pelo navegador real.');
        return { solved: true, token: 'present', skipped: false };
      }

      await clickTurnstile(page, log);

      const token = await waitForTurnstileSolved(page, { timeout: isProxyActive() ? 1800 : 2500 });
      if (token) {
        log?.info?.('Turnstile resolvido pelo navegador real.');
        return { solved: true, token, skipped: false };
      }

      await sleep(isProxyActive() ? 400 : 600);
    }

    log?.warn?.('Turnstile nao resolvido (IP/proxy pode estar ruim).');
    return { solved: false, token: null, skipped: false };
  });
}
