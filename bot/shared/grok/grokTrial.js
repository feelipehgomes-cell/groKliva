import { config } from '../config.js';
import { effectiveTrialCheckMs, isProxyActive } from '../proxy/proxy.js';
import {
  dismissCookieBanner,
  dismissPostLoginOverlays,
  gotoWithRetry,
  ensureSubscribePageReady,
  sleep,
  wakePage,
} from '../browser/pageHelpers.js';
import {
  TRIAL_OFFER_SUBSTRINGS,
  TRIAL_UPGRADE_ONLY,
  evaluateTrialPageState,
  trialPlanOfferVisibleInPage,
  isPaidOnlySubscribePageInPage,
} from './trialOffer.js';

const NAV_TIMEOUT = config.navTimeout;

/**
 * Detecta trial exclusivamente na tela #subscribe (mais confiavel que a home).
 * @returns {Promise<boolean>} true = CTA trial $0 visivel; false = sem trial ou so planos pagos
 */
export async function detectTrialOnSubscribePage(page, { log, timeoutMs, navigate = true } = {}) {
  if (navigate) {
    const ready = await ensureSubscribePageReady(page, { log, formTimeout: 10000 });
    page = ready.page;
    if (!ready.ok) {
      log?.warn?.('Nao foi possivel abrir #subscribe — tentando detectar trial mesmo assim.');
    }
  } else {
    await wakePage(page);
    await dismissPostLoginOverlays(page, { subscribeSafe: true });
    await dismissCookieBanner(page, { timeout: 2500 }).catch(() => {});
  }

  const url = page.url();
  if (!/#subscribe|\/plans|\/upgrade/i.test(url)) {
    log?.warn?.(`Fora de #subscribe (${url.slice(0, 80)}) — tentando abrir de novo.`);
    page = (await ensureSubscribePageReady(page, { log, formTimeout: 8000 })).page;
  }

  log?.info?.(`Checando trial em #subscribe: ${page.url().slice(0, 100)}`);

  if (await page.evaluate(isPaidOnlySubscribePageInPage).catch(() => false)) {
    log?.warn?.('Tela #subscribe so com planos pagos ($10/$30/$99) — sem trial $0.');
    return false;
  }

  // Conta com trial: botao $0 costuma aparecer em 1–3s. Paid-only aborta na hora.
  const waitMs = timeoutMs ?? (isProxyActive() ? 5500 : 4500);
  const pollMs = isProxyActive() ? 120 : 100;
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    if (await page.evaluate(trialPlanOfferVisibleInPage).catch(() => false)) {
      log?.info?.('Trial DISPONIVEL em #subscribe (Solicitar oferta $0).');
      return true;
    }
    if (await page.evaluate(isPaidOnlySubscribePageInPage).catch(() => false)) {
      log?.warn?.('Tela #subscribe so com planos pagos ($10/$30/$99) — sem trial $0.');
      return false;
    }
    await sleep(pollMs);
  }

  if (await page.evaluate(isPaidOnlySubscribePageInPage).catch(() => false)) {
    log?.warn?.('Tela #subscribe so com planos pagos ($10/$30/$99) — sem trial $0.');
    return false;
  }

  log?.warn?.('CTA trial $0 nao encontrado em #subscribe.');
  return false;
}

/**
 * Verifica trial na HOME (login PIX).
 * Checagem estrita: $0.00 / gratis — nao recarrega se ja estiver em grok.com.
 * @param {object} [opts]
 * @param {boolean} [opts.quickCheck] — menos espera na home; confirma em #subscribe se necessario
 * @returns {Promise<boolean>}
 */
export async function isTrialOfferAvailable(page, { log, quickCheck = false } = {}) {
  const home = (config.postLoginUrl || 'https://grok.com').replace(/\/$/, '');
  const currentUrl = page.url();
  const onSubscribe = /#subscribe|\/plans|\/upgrade/i.test(currentUrl);

  if (onSubscribe) {
    log?.debug?.('Ja na tela de planos — checando trial sem reload.');
    const hasPlanCta = await page.evaluate(trialPlanOfferVisibleInPage).catch(() => false);
    return hasPlanCta;
  }

  const onHome =
    currentUrl.includes('grok.com') && !/sign-?in|login|accounts\.x\.ai|\/auth/i.test(currentUrl);

  const settleMs = quickCheck ? (isProxyActive() ? 300 : 250) : 800;
  const afterScrollMs = quickCheck ? (isProxyActive() ? 200 : 150) : 500;
  const pollMs = quickCheck ? (isProxyActive() ? 150 : 200) : 400;
  // UI nova pode nao mostrar NADA de trial na home — nao gastar 15s aqui;
  // a confirmacao definitiva e em #subscribe logo abaixo.
  const checkMs = quickCheck
    ? Math.min(effectiveTrialCheckMs(true), 6000)
    : Math.max(config.trialCheckMs, 10000);

  if (onHome) {
    log?.info?.('Ja na home — checando trial sem reload.');
    await sleep(settleMs);
  } else {
    log?.info?.(`Verificando trial na home: ${home}`);
    await gotoWithRetry(page, home, { log, retries: 2, timeout: NAV_TIMEOUT }).catch((e) => {
      log?.warn?.(`Falha ao abrir home: ${e.message}`);
    });
  }

  await wakePage(page);
  await dismissPostLoginOverlays(page, { subscribeSafe: quickCheck });
  await page
    .evaluate(() => {
      /* eslint-disable no-undef */
      window.scrollTo(0, document.body.scrollHeight);
      /* eslint-enable no-undef */
    })
    .catch(() => {});
  await sleep(afterScrollMs);
  log?.info?.(`Home: ${page.url()}`);

  const deadline = Date.now() + checkMs;
  let sawUpgrade = false;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(evaluateTrialPageState, TRIAL_OFFER_SUBSTRINGS, TRIAL_UPGRADE_ONLY)
      .catch((err) => {
        log?.warn?.(`Erro ao avaliar trial: ${err.message}`);
        return 'none';
      });

    if (state === 'offer') {
      log?.info?.('Trial DISPONIVEL na home.');
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      return true;
    }
    if (state === 'upgrade') {
      sawUpgrade = true;
      // "Aprimorar" na nav aparece mesmo com trial — nao encerrar aqui.
    }
    await sleep(pollMs);
  }

  log?.warn?.(
    sawUpgrade
      ? '"Aprimorar" na home — confirmando trial em #subscribe...'
      : 'Oferta trial nao apareceu na home a tempo — checando #subscribe...',
  );
  if (await detectTrialOnSubscribePage(page, { log })) {
    return true;
  }

  if (sawUpgrade) {
    log?.warn?.('Sem CTA $0 em #subscribe — conta SEM trial.');
  } else {
    log?.warn?.('Oferta trial ($0.00 / gratis) NAO aparece na home nem em #subscribe.');
  }
  return false;
}
