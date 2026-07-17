import { config } from '../config.js';
import {
  screenshot,
  resolveActivePage,
  focusPage,
} from '../browser/browser.js';
import { getPayerData, rotatePayerAfterDecline } from '../pix/payer.js';
import {
  capturePixOnce,
  detectStripePixContext,
  attachPixNetworkCapture,
} from '../pix/pixExtract.js';
import { resolveStripeCheckoutPage } from '../browser/browser.js';
import {
  attachStripeDiagnostics,
  readStripeUiState,
  logStripeUiState,
  detectCardDeclinedError,
} from './stripeDiag.js';
import { stopBackgroundTurnstileSolver } from '../browser/turnstile.js';
import {
  clickByText,
  sleep,
  wakePage,
  isSubscribePlanUrl,
  isSubscribeUiVisible,
  openSubscribeHashIfOnGrokHome,
  installCookieAutoDismiss,
  dismissCookieBanner,
  dismissSubscribeClickBlockers,
} from '../browser/pageHelpers.js';
import { isBrowserConnected, isProxyActive } from '../proxy/proxy.js';
import {
  TRIAL_OFFER_SUBSTRINGS,
  trialOfferClickInPage,
  isOnTrialPlanScreenInPage,
  dismissSubscribeProcessingErrorInPage,
  SUBSCRIBE_PROCESSING_ERROR_PATTERNS,
  trialPlanOfferClickInPage,
  trialPlanOfferVisibleInPage,
  isPaidOnlySubscribePageInPage,
  isTrialPlanButtonLabel,
  evaluateStripeCheckoutTrialInPage,
} from './trialOffer.js';
import {
  subscribeActivityStart,
  subscribeActivityUpdate,
  subscribeActivityEnd,
} from '../whatsapp/subscribeActivity.js';

// CTA trial: "Experimente por $0.00" OU "Experimente grátis" OU planos.
const TRIAL_CTA_TEXTS = [
  ...TRIAL_OFFER_SUBSTRINGS,
  'experimente por',
  'experimente grátis',
  'experimente gratis',
  'solicitar oferta',
  'experimente 7 dias',
  'experimentar',
  'teste grátis',
  'teste gratis',
  'free trial',
  'start trial',
  'ativar trial',
];

const TRIAL_CARD_TEXTS = [
  ...TRIAL_OFFER_SUBSTRINGS,
  'solicitar oferta',
  'trial gratuito',
  'teste gratuito',
];

/** Botao trial na tela #subscribe (SuperGrok $0). */
const TRIAL_PLAN_CTA_SELECTORS = [
  '[data-testid="plan-cta-supergrok"]',
  'button[data-testid="plan-cta-supergrok"]',
  '[data-testid*="plan-cta-supergrok" i]',
];

const STRIPE_PIX_SELECTORS = [
  '[data-testid="pix-accordion-item-button"]',
  '[data-testid="pix-accordion-item"] .AccordionItemHeader--clickable',
  '#payment-method-label-pix',
  '#payment-method-accordion-item-title-pix',
  'input[value="pix"]',
];

const PIX_TEXTS = [
  'pix',
  'pagar com pix',
  'pagamento instantâneo',
  'pagamento instantaneo',
];

const STRIPE_SUBMIT_SELECTORS = [
  '[data-testid="hosted-payment-submit-button"]',
  'button.SubmitButton[type="submit"]',
];

const STRIPE_CPF_SELECTORS = [
  '#taxId',
  'input[name="taxId"]',
  'input[autocomplete="tax-id"]',
  'input.CheckoutInput[autocomplete="tax-id"]',
  'input[placeholder="000.000.000-00"]',
  'input[placeholder*="000.000" i]',
  'input[placeholder*="CPF" i]',
  'input[aria-label*="CPF" i]',
  'input[aria-label*="CNPJ" i]',
  'input[name*="cpf" i]',
  'input[id*="cpf" i]',
];

const STRIPE_NAME_SELECTORS = [
  'input[name="name"]',
  'input[autocomplete="name"]',
  'input[placeholder*="Nome completo" i]',
  'input[aria-label*="Nome completo" i]',
  'input[name="billingName"]',
  'input[autocomplete="cc-name"]',
  'input[placeholder*="pagador" i]',
  'input[aria-label*="pagador" i]',
  'input[placeholder*="nome" i]',
  'input[aria-label*="nome" i]',
];

const REVEAL_QR_TEXTS = [
  'revelar código qr',
  'revelar codigo qr',
  'revelar código',
  'revelar codigo',
  'revelar',
  'iniciar teste',
  'start trial',
];

/**
 * Fluxo pos-login: CTA trial -> PIX -> nome/CPF -> tela QR.
 */
export async function subscribeTrialPix(
  page,
  account,
  { log, browser, workerId, _frameRetry = 0, _resumeStripe = false } = {},
) {
  const sel = config.selectors;
  const progress = { subscribeAttempts: 0, subscribeGrokErrors: 0 };
  subscribeActivityStart(account.email, { workerId, phase: 'subscribe' });


  try {
    log.info('Iniciando assinatura trial via PIX...');
    stopBackgroundTurnstileSolver(page, log);
    await focusPage(page, log);
    await wakePage(page);
    await installCookieAutoDismiss(page);
    await dismissCookieBanner(page, { timeout: 1500 }).catch(() => {});

    // Apos frame quebrado no Stripe: retomar checkout — nao voltar aos planos.
    let skipPlans =
      _resumeStripe || isStripeCheckoutUrl(String(page?.url?.() || ''));
    if (skipPlans) {
      page = await resolveStripeCheckoutPage(browser, page, log).catch(
        () => page,
      );
      skipPlans = isStripeCheckoutUrl(String(page?.url?.() || ''));
    }

    if (!skipPlans) {
      page = await resolveGrokPlanPage(browser, page, log);

      if (await isPaidOnlySubscribePage(page)) {
        await screenshot(page, `paid-plans-only-${safe(account.email)}`, log);
        return fail('conta sem trial: tela de planos pagos ($10/$30/$99)');
      }

      const plansReadyOk = await ensureTrialPlansReady(page, log, browser);
      if (!plansReadyOk) {
        page = await resolveGrokPlanPage(browser, page, log);
        if (await isPaidOnlySubscribePage(page)) {
          await screenshot(page, `paid-plans-only-${safe(account.email)}`, log);
          return fail('conta sem trial: tela de planos pagos ($10/$30/$99)');
        }
        await screenshot(page, `no-trial-cta-${safe(account.email)}`, log);
        return fail('CTA do trial nao encontrado');
      }
      page = await resolveGrokPlanPage(browser, page, log);
      await dismissSubscribeClickBlockers(page);

      if (await isPaidOnlySubscribePage(page)) {
        await screenshot(page, `paid-plans-only-${safe(account.email)}`, log);
        return fail('conta sem trial: tela de planos pagos ($10/$30/$99)');
      }

      // Clica assim que o botao $0 aparecer (retorno imediato quando visivel).
      if (!(await waitForTrialPlanCta(page, 18000))) {
        await screenshot(page, `no-plan-page-${safe(account.email)}`, log);
        if (await isPaidOnlySubscribePage(page)) {
          return fail('conta sem trial: tela de planos pagos ($10/$30/$99)');
        }
        return fail('CTA trial $0.00 nao encontrado (Solicitar oferta de $0.00)');
      }

      log.info('CTA trial $0 visivel — clicando Solicitar oferta...');
      page = await resolveGrokPlanPage(browser, page, log);
      log.debug(`Tela de planos pronta: ${page.url()}`);

      const toStripe = await pollThroughTrialPlanToStripe(
        browser,
        page,
        log,
        sel,
        {
          email: account.email,
          workerId,
          progress,
        },
      );
      if (!toStripe.ok) {
        await screenshot(
          toStripe.page,
          `trial-plan-stuck-${safe(account.email)}`,
          log,
        );
        return fail(
          toStripe.reason || 'travado na selecao do plano trial',
          progress,
        );
      }
      page = toStripe.page;
    } else {
      log.info('Checkout Stripe ja aberto — retomando PIX (sem voltar aos planos).');
    }

    subscribeActivityUpdate(account.email, { phase: 'stripe' });
    await wakePage(page);

    const paidCheckout = await guardStripeTrialOrFail(page, browser, log);
    if (!paidCheckout.ok) {
      await screenshot(
        paidCheckout.page,
        `paid-stripe-checkout-${safe(account.email)}`,
        log,
      );
      return fail(paidCheckout.reason, progress);
    }
    page = paidCheckout.page;

    await waitForStripePaymentContexts(page, log);

    if (!(await selectPixPayment(page, sel, log, browser))) {
      page = await resolveStripeCheckoutPage(browser, page, log);
      await sleep(400);
      page = await waitForStripeCheckoutReady(
        browser,
        page,
        log,
        Math.min(12000, Math.round(stripeCheckoutWaitMs() * 0.5)),
      );
      if (!(await selectPixPayment(page, sel, log, browser))) {
        page = await resolveStripeCheckoutPage(browser, page, log);
        await screenshot(page, `no-pix-option-${safe(account.email)}`, log);
        return fail('opcao PIX nao encontrada', progress);
      }
    }
    page = await resolveStripeCheckoutPage(browser, page, log);
    await sleep(120);

    const paidBeforePayer = await guardStripeTrialOrFail(page, browser, log);
    if (!paidBeforePayer.ok) {
      await screenshot(
        paidBeforePayer.page,
        `paid-stripe-before-payer-${safe(account.email)}`,
        log,
      );
      return fail(paidBeforePayer.reason, progress);
    }
    page = paidBeforePayer.page;

    // Layout radio: CPF/nome aparecem apos selecionar Pix — aguardar expandir.
    let payerFields = { hasCpf: false, hasName: false };
    const payerWaitStart = Date.now();
    while (Date.now() - payerWaitStart < 10000) {
      payerFields = await detectPayerFieldsPresent(page);
      if (payerFields.hasCpf || payerFields.hasName) break;
      await sleep(200);
    }

    const MAX_PAYER_ROTATIONS = 5;
    let payer = null;
    let payerRotations = 0;
    let stripeDiag = null;
    let detachPixNet = null;


    while (true) {
      if (payerFields.hasCpf || payerFields.hasName) {
        if (!payer) payer = await getPayerData(account);
        subscribeActivityUpdate(account.email, { phase: 'nome/cpf' });
        log.info(
          `Preenchendo pagador: ${payer.name} (CPF ${payer.cpfMasked})` +
            (payer.resultado
              ? ` [resultado ${payer.resultado} — uso ${payer.payerUseIndex}/${payer.payerUseCap}]`
              : '') +
            (payerRotations ? ` (troca #${payerRotations})` : ''),
        );
        page = await resolveStripeCheckoutPage(browser, page, log);
        await focusPage(page, log);
        await wakePage(page);

        const payerReady = await ensurePayerFieldsReady(
          page,
          sel,
          payer,
          payerFields,
          log,
        );
        if (!payerReady) {
          await screenshot(page, `no-payer-fields-${safe(account.email)}`, log);
          return fail('campos nome/CPF nao preenchidos no Stripe', progress);
        }
      } else if (!payerRotations) {
        log.info('Stripe sem campos CPF/nome — seguindo para Iniciar teste.');
      }

      subscribeActivityUpdate(account.email, { phase: 'revelar qr' });
      await waitForRevealButtonReady(page, log);
      await sleep(120);

      stripeDiag?.detach?.();
      detachPixNet?.();
      stripeDiag = attachStripeDiagnostics(page, log);
      page = await resolveStripeCheckoutPage(browser, page, log);
      detachPixNet = attachPixNetworkCapture(page, log);

      const revealed = await clickRevealQrAndWait(page, browser, sel, log);
      if (revealed) {
        page = revealed;
        break;
      }

      const activePage = await resolveStripeCheckoutPage(browser, page, log);
      const declinedMsg = await detectCardDeclinedError(activePage);
      const canRotate = !!(
        declinedMsg &&
        payer?.cpf &&
        payerFields.hasCpf &&
        payerRotations < MAX_PAYER_ROTATIONS
      );
      if (canRotate) {
        payerRotations += 1;
        log.warn(
          `Stripe recusou cartao/CPF ${payer.cpfMasked}: "${declinedMsg.slice(0, 120)}" — removendo da lista e tentando proximo (${payerRotations}/${MAX_PAYER_ROTATIONS})...`,
        );
        try {
          payer = await rotatePayerAfterDecline(account, payer.cpf);
          log.info(
            `Proximo pagador: ${payer.name} (CPF ${payer.cpfMasked})` +
              (payer.resultado
                ? ` [resultado ${payer.resultado} — uso ${payer.payerUseIndex}/${payer.payerUseCap}]`
                : ''),
          );
        } catch (rotErr) {
          stripeDiag.detach();
          detachPixNet?.();
          await screenshot(
            activePage,
            `card-declined-no-payer-${safe(account.email)}`,
            log,
          );
          return fail(
            `cartao/CPF recusado e sem proximo pagador: ${rotErr.message}`,
            progress,
          );
        }
        page = activePage;
        continue;
      }

      const fallback = await detectStripePixContext(browser, activePage, log);
      if (fallback.state.hasPix) {
        log.info('QR PIX detectado no fallback — tentando captura...');
        page = fallback.page;
        break;
      }

      const ui = await readStripeUiState(activePage);
      logStripeUiState(ui, log);
      const diag = stripeDiag.getSummary();
      if (diag.httpFailures.length)
        log.warn('Falhas HTTP Stripe:', JSON.stringify(diag.httpFailures));
      stripeDiag.detach();
      detachPixNet?.();
      await screenshot(
        activePage,
        `no-reveal-qr-${safe(account.email)}`,
        log,
      );
      return fail(
        declinedMsg
          ? `cartao/CPF recusado pelo Stripe: ${declinedMsg.slice(0, 120)}`
          : 'botao Revelar codigo QR nao encontrado ou QR sumiu (veja logs Stripe acima)',
        progress,
      );
    }

    stripeDiag?.detach?.();
    page = await resolveStripeCheckoutPage(browser, page, log);
    log.info('Capturando PIX e enviando...');

    const pix = await capturePixOnce(page, {
      email: account.email,
      log,
      browser,
      waitMs: 2000,
    });

    if (!pix || (!pix.copyPaste && !pix.qrImagePath)) {
      detachPixNet?.();
      await screenshot(page, `no-pix-screen-${safe(account.email)}`, log);
      return fail(
        'tela PIX nao apareceu ou QR sumiu antes da captura',
        progress,
      );
    }

    log.info('PIX capturado com sucesso.');
    detachPixNet?.();

    return {
      ok: true,
      reason: 'pix gerado',
      url: page.url(),
      pix,
      payer,
    };
  } catch (err) {
    // Frame quebrado (rebrowser acquireContextId) e transiente: reload real
    // recria o frame — retenta o fluxo em vez de fechar a instancia.
    if (isFrameBrokenError(err) && _frameRetry < 2 && browser) {
      log.warn(
        'Frame quebrado no subscribe — recuperando via reload e retentando...',
      );
      const recovered = await recoverBrokenFrame(browser, page, log);
      const resumeStripe = isStripeCheckoutUrl(
        String(recovered?.url?.() || page?.url?.() || ''),
      );
      return subscribeTrialPix(recovered || page, account, {
        log,
        browser,
        workerId,
        _frameRetry: _frameRetry + 1,
        _resumeStripe: resumeStripe,
      });
    }
    log.error(`Erro na assinatura: ${err.message}`);
    await screenshot(page, `subscribe-error-${safe(account.email)}`, log).catch(
      () => {},
    );
    return fail(err.message, progress);
  } finally {
    subscribeActivityEnd(account.email);
  }
}

/** Erro transiente do rebrowser-patches ao (re)criar contexto do frame. */
function isFrameBrokenError(err) {
  const msg = err?.message || String(err || '');
  return /acquireContextId failed|createIsolatedWorld|No frame (with|for) given id|Runtime\.addBinding|context was destroyed|detached Frame|Session closed/i.test(
    msg,
  );
}

/** Reload real para recriar o frame quebrado e reabrir #subscribe. */
async function recoverBrokenFrame(browser, page, log) {
  const base = (config.postLoginUrl || 'https://grok.com').replace(/\/$/, '');
  try {
    // Se o checkout Stripe ja estava aberto, NUNCA voltar pro #subscribe
    // (isso causava ping-pong Stripe → subscribe).
    const stripe = await resolveStripeCheckoutPage(browser, page, log).catch(
      () => null,
    );
    if (stripe && isStripeCheckoutUrl(stripe.url?.() || '')) {
      log?.warn?.(
        'Frame quebrado no Stripe — recarregando checkout (sem voltar ao subscribe).',
      );
      await stripe.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(800);
      browser.__realPage = stripe;
      return stripe;
    }

    page = await resolveGrokPlanPage(browser, page, log).catch(() => page);

    // Frame irrecuperavel (evaluate falha ate depois do reload): abre aba nova
    // na mesma sessao e descarta a quebrada.
    const healthy = await page.evaluate(() => true).catch(() => false);
    if (!healthy) {
      const fresh = await browser.newPage().catch(() => null);
      if (fresh) {
        log?.warn?.('Frame morto — abrindo aba nova para #subscribe.');
        await fresh
          .goto(`${base}/#subscribe`, { waitUntil: 'domcontentloaded' })
          .catch(() => {});
        await page.close().catch(() => {});
        browser.__realPage = fresh;
        await sleep(800);
        await dismissCookieBanner(fresh, { timeout: 3000 }).catch(() => {});
        return fresh;
      }
    }

    await page
      .goto(`${base}/#subscribe`, { waitUntil: 'domcontentloaded' })
      .catch(() => {});
    await sleep(800);
    await dismissCookieBanner(page, { timeout: 3000 }).catch(() => {});
    return page;
  } catch {
    return page;
  }
}

async function isOnSubscribeOrPlanPage(page) {
  if (await page.evaluate(trialPlanOfferVisibleInPage).catch(() => false))
    return true;
  return (
    isSubscribePlanUrl(page.url?.() || '') && (await isSubscribeUiVisible(page))
  );
}

async function isPaidOnlySubscribePage(page) {
  return page.evaluate(isPaidOnlySubscribePageInPage).catch(() => false);
}

async function assertStripeIsTrialCheckout(
  page,
  log,
  { logOnFail = true } = {},
) {
  const result = await page
    .evaluate(evaluateStripeCheckoutTrialInPage)
    .catch((e) => ({ ok: false, reason: `erro ao ler Stripe: ${e.message}` }));

  if (!result.ok && logOnFail) {
    log.error(`ABORT: ${result.reason} — nao assinar plano pago.`);
  }
  return result;
}

async function guardStripeTrialOrFail(page, browser, log, { settleMs } = {}) {
  if (browser) {
    page = await resolveStripeCheckoutPage(browser, page, log).catch(
      () => page,
    );
  }

  // Stripe /g/pay abre a URL antes do DOM. Esperar carregar antes de concluir "sem trial".
  // Nao abortar cedo por "sem trial $0" ambíguo — so plano pago claro fecha a instancia.
  const waitMs = settleMs ?? Math.max(22000, stripeCheckoutWaitMs());
  const deadline = Date.now() + waitMs;
  let last = { ok: false, reason: 'checkout Stripe sem trial $0' };
  let loggedLoading = false;
  const openedAt = Date.now();

  while (Date.now() <= deadline) {
    const check = await assertStripeIsTrialCheckout(page, log, {
      logOnFail: false,
    });
    if (check.ok) {
      return { ok: true, page };
    }
    last = check;

    // Ainda carregando: nao abortar cedo.
    if (check.loading) {
      if (!loggedLoading) {
        log.debug(
          `Aguardando checkout Stripe carregar (${Math.round(waitMs / 1000)}s)...`,
        );
        loggedLoading = true;
      }
      await sleep(350);
      if (browser) {
        page = await resolveStripeCheckoutPage(browser, page, log).catch(
          () => page,
        );
      }
      continue;
    }

    // Plano pago detectado com certeza — abortar sem esperar o timeout cheio.
    // Mas dar pelo menos ~2.5s apos abrir (DOM intermediario pode parecer pago).
    if (
      /plano pago|valor pago|botao plano pago/i.test(String(check.reason || ''))
    ) {
      if (Date.now() - openedAt >= 2500) break;
      await sleep(300);
      if (browser) {
        page = await resolveStripeCheckoutPage(browser, page, log).catch(
          () => page,
        );
      }
      continue;
    }

    // Motivo ambiguo ("sem trial $0"): continua aguardando ate o deadline.
    if (Date.now() >= deadline) break;
    await sleep(350);
    if (browser) {
      page = await resolveStripeCheckoutPage(browser, page, log).catch(
        () => page,
      );
    }
  }

  if (!last.ok) {
    log.error(`ABORT: ${last.reason} — nao assinar plano pago.`);
  }
  return {
    ok: false,
    page,
    reason: last.reason || 'checkout Stripe pago — conta sem trial',
  };
}

function isHomeChatPage(url = '') {
  return (
    /grok\.com/i.test(url) &&
    !/#subscribe|\/plans|\/upgrade|checkout\.stripe/i.test(url)
  );
}

/**
 * Abre a tela de planos a partir da home clicando o CTA trial
 * ("Experimente por $0.00") — como nas primeiras versoes. Sem navegar por
 * hash/reload (lento e causava ping-pong subscribe→home).
 */
async function ensureTrialPlansReady(page, log, browser) {
  page = await resolveGrokPlanPage(browser, page, log);
  await dismissSubscribeClickBlockers(page);

  if (await isOnSubscribeOrPlanPage(page)) {
    log.debug('Tela de planos ja aberta — pulando cliques da home.');
    return true;
  }

  if (await isPaidOnlySubscribePage(page)) {
    log.warn('Tela de planos pagos detectada — conta sem trial $0.');
    return false;
  }

  if (!isHomeChatPage(page.url())) {
    log.debug('Aguardando planos (sem cliques extras)...');
    await sleep(800);
    if (await isOnSubscribeOrPlanPage(page)) return true;
  }

  // Router SPA precisa estar hidratado para reagir ao hash — hash aplicado
  // cedo demais e ignorado e a instancia fica "presa" na home.
  await page
    .waitForFunction(
      () =>
        /* eslint-disable no-undef */
        document.readyState === 'complete' &&
        !!document.querySelector('main, textarea, [contenteditable], [data-testid]'),
      /* eslint-enable no-undef */
      { timeout: 3000, polling: 120 },
    )
    .catch(() => {});

  // Banner de cookies do grok.com renderiza APOS a hidratacao — o observer
  // in-page fecha na hora; dismiss extra cobre banner ja aberto.
  await installCookieAutoDismiss(page);
  await dismissCookieBanner(page, { timeout: 1200 }).catch(() => {});

  // 1) Abre o modal de planos via #subscribe (hash SPA, ~1s). Se o router
  //    ignorou o primeiro hash (hidratacao tardia), reaplica com reset.
  for (let i = 0; i < 3; i++) {
    await openSubscribeHashIfOnGrokHome(page, { log, force: i > 0 });
    const ctaOk = await waitForTrialPlanCta(page, i === 0 ? 5000 : 4000);
    if (ctaOk) return true;
    if (await isPaidOnlySubscribePage(page)) {
      log.warn('Tela de planos pagos detectada — conta sem trial $0.');
      return false;
    }
    log.debug(`Modal de planos nao abriu (tentativa ${i + 1}) — dispensando overlays e reaplicando hash...`);
    await dismissCookieBanner(page, { timeout: 1200 }).catch(() => {});
  }

  // 2) Fallback UI antiga: banner/CTA trial na home (Experimente por $0.00).
  if (isHomeChatPage(page.url())) {
    log.debug('Hash nao abriu planos — clicando CTA trial da home...');
    if (await pollClickTrialOffer(page, browser, log, 5000)) return true;
  }

  return isOnSubscribeOrPlanPage(page);
}

/** @deprecated use ensureTrialPlansReady */
async function openPlansFromHome(page, log, browser) {
  return ensureTrialPlansReady(page, log, browser);
}

/** Clica "Experimente por $0.00" — banner fixo no rodape (so na HOME, nunca em #subscribe). */
async function pollClickTrialOffer(page, browser, log, timeoutMs = 14000) {
  let active = page;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isOnSubscribeOrPlanPage(active)) {
      log.debug('Tela de planos aberta — parando cliques da home.');
      return true;
    }

    if (browser) {
      active = await resolveGrokPlanPage(browser, active, log).catch(
        () => active,
      );
    }

    if (await isOnSubscribeOrPlanPage(active)) {
      log.debug('Tela de planos aberta apos CTA.');
      return true;
    }

    if (!isHomeChatPage(active.url())) {
      await sleep(350);
      continue;
    }

    try {
      const r = await active.evaluate(
        trialOfferClickInPage,
        TRIAL_OFFER_SUBSTRINGS,
      );
      if (r?.ok) {
        log.info(`CTA trial clicado (${r.tag}): ${r.text}`);
        await sleep(400);
        if (await isOnSubscribeOrPlanPage(active)) return true;
        if (await waitForTrialPlanCta(active, 10000)) return true;
      }
    } catch (err) {
      if (
        /detached|target closed|acquireContextId|No frame with given id/i.test(
          err.message,
        ) &&
        browser
      ) {
        active = await resolveGrokPlanPage(browser, active, log).catch(
          () => active,
        );
      } else {
        log?.debug?.(`pollClickTrialOffer: ${err.message}`);
      }
    }
    await sleep(350);
  }
  return isOnSubscribeOrPlanPage(active);
}

async function waitForTrialPlanCta(page, timeoutMs = 10000) {
  // Dismiss UMA vez no inicio — repetir a cada poll travava a instancia (~4s/loop).
  await dismissSubscribeClickBlockers(page);
  const start = Date.now();
  let lastDismiss = start;
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(trialPlanOfferVisibleInPage).catch(() => false))
      return true;
    // So aborta cedo se o MEIO da tela ja for plano pago (Melhorar), nunca so por Lite/Heavy.
    if (await page.evaluate(isPaidOnlySubscribePageInPage).catch(() => false))
      return false;
    // Re-dismiss so de tempos em tempos (banner pode surgir tarde).
    if (Date.now() - lastDismiss > 2500) {
      await dismissSubscribeClickBlockers(page);
      lastDismiss = Date.now();
    }
    await sleep(100);
  }
  return false;
}

async function waitForPlanCtaButton(page, timeoutMs = 10000) {
  return waitForTrialPlanCta(page, timeoutMs);
}

async function resolveGrokPlanPage(browser, page, log) {
  try {
    const pages = (await browser?.pages?.()) || [];

    for (let i = pages.length - 1; i >= 0; i--) {
      const p = pages[i];
      const url = p.url?.() || '';
      if (!/grok\.com|x\.ai/i.test(url) || /checkout\.stripe/i.test(url))
        continue;
      try {
        const hasPlan = await p
          .evaluate(
            () =>
              !!document.querySelector('[data-testid="plan-cta-supergrok"]'),
          )
          .catch(() => false);
        if (hasPlan) {
          browser.__realPage = p;
          return focusPage(p, log);
        }
      } catch {
        /* tab inutil */
      }
    }

    for (let i = pages.length - 1; i >= 0; i--) {
      const url = pages[i].url?.() || '';
      if (/#subscribe|\/plans|\/upgrade/i.test(url)) {
        browser.__realPage = pages[i];
        return focusPage(pages[i], log);
      }
    }
  } catch {
    /* noop */
  }

  if (page && /grok\.com|x\.ai/i.test(page.url())) {
    const url = page.url();
    if (isSubscribePlanUrl(url)) return page;
    try {
      const hasPlan = await page
        .evaluate(
          () => !!document.querySelector('[data-testid="plan-cta-supergrok"]'),
        )
        .catch(() => false);
      if (hasPlan) return page;
    } catch {
      /* noop */
    }
    return page;
  }
  return resolveActivePage(browser, page, log);
}

function isStripeCheckoutUrl(url = '') {
  return /checkout\.stripe\.com|stripe\.com\/(?:c\/)?pay|buy\.stripe|stripe\.com\/g\/pay/i.test(
    String(url || ''),
  );
}

async function resolveSubscribeFlowPage(browser, page, log) {
  try {
    // Preferir resolveStripeCheckoutPage (cobre /g/pay, buy.stripe, etc.).
    const stripe = await resolveStripeCheckoutPage(browser, page, log).catch(
      () => null,
    );
    if (stripe && isStripeCheckoutUrl(stripe.url?.() || '')) {
      return stripe;
    }

    const pages = (await browser?.pages?.()) || [];
    for (let i = pages.length - 1; i >= 0; i--) {
      const p = pages[i];
      if (!p || (typeof p.isClosed === 'function' && p.isClosed())) continue;
      let url = '';
      try {
        url = p.url?.() || '';
      } catch {
        continue;
      }
      if (isStripeCheckoutUrl(url)) {
        browser.__realPage = p;
        return focusPage(p, log);
      }
    }
  } catch {
    /* noop */
  }
  return resolveGrokPlanPage(browser, page, log);
}

async function clickTrialPlanOfferBySelector(page, log) {
  const selectors = [
    ...TRIAL_PLAN_CTA_SELECTORS,
    config.selectors.trialCard,
  ].filter(Boolean);

  const unique = [
    ...new Set(
      selectors
        .join(',')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];

  for (const sel of unique) {
    try {
      const handles = await page.$$(sel);
      for (const el of handles) {
        const label = await el
          .evaluate((node) => (node.innerText || node.textContent || '').trim())
          .catch(() => '');
        if (!isTrialPlanButtonLabel(label)) {
          if (label)
            log.debug(
              `Ignorando botao pago (nao e trial $0): "${label.slice(0, 80)}"`,
            );
          continue;
        }
        // Clique DOM — mouse por boundingBox falha com a infobar --no-sandbox (fecha o X).
        const clicked = await el
          .evaluate((node) => {
            /* eslint-disable no-undef */
            node.scrollIntoView({ block: 'center', inline: 'nearest' });
            node.click();
            return true;
            /* eslint-enable no-undef */
          })
          .catch(() => false);
        if (!clicked) {
          await el.click({ delay: 40 }).catch(() => null);
        }
        log.info(
          `Plano trial clicado (${sel}): ${label || 'Solicitar oferta de $0.00'}`,
        );
        return true;
      }
    } catch {
      /* proximo selector */
    }
  }
  return false;
}

/**
 * Clique com mouse REAL (CDP) no centro do CTA trial — evento confiavel,
 * necessario porque o Grok abre o Stripe via window.open (popup blocker
 * ignora click() sintetico). Mede o retangulo DEPOIS do scrollIntoView e
 * confere com elementFromPoint que o alvo e mesmo o CTA (nunca o X do modal).
 */
async function clickTrialPlanOfferViaMouse(page, log) {
  const coords = await page
    .evaluate(() => {
      /* eslint-disable no-undef */
      const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return false;
        const st = window.getComputedStyle(el);
        return (
          st.display !== 'none' &&
          st.visibility !== 'hidden' &&
          st.opacity !== '0'
        );
      };
      const isTrialBtn = (t) =>
        /solicitar\s+oferta\s+(de\s+\$0|gratuita|gr[aá]tis)/i.test(t) ||
        (t.includes('solicitar oferta') && /\$0|0\.00|0,00/.test(t)) ||
        (/experimente/.test(t) && /\$0|0\.00|gr[aá]tis/.test(t));

      for (const el of document.querySelectorAll(
        '[data-testid="plan-cta-supergrok"], button, [role="button"]',
      )) {
        if (!isVisible(el)) continue;
        const label = norm(el.innerText || el.textContent || '');
        if (!isTrialBtn(label)) continue;

        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        // Retangulo APOS o scroll — antes ficava obsoleto e o clique caia fora.
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;

        // Garante que o ponto realmente atinge o CTA (nao um overlay/X).
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(el === hit || el.contains(hit) || hit.contains(el)))
          return { ok: false };

        return { ok: true, x, y, text: label.slice(0, 80) };
      }
      return { ok: false };
      /* eslint-enable no-undef */
    })
    .catch(() => ({ ok: false }));

  if (!coords?.ok) return false;

  await page.mouse.move(coords.x, coords.y, { steps: 4 });
  await sleep(40);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  log.info(
    `Plano trial clicado (mouse): ${coords.text || 'Solicitar oferta de $0.00'}`,
  );
  return true;
}

async function waitForStripeAfterPlanClick(
  browser,
  page,
  log,
  timeoutMs = 25000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      page = await resolveStripeCheckoutPage(browser, page, log).catch(
        () => page,
      );
      if (isStripeCheckoutUrl(page.url?.() || '')) return page;
      if (await isStripeCheckoutUiReady(page)) return page;

      const pages = (await browser?.pages?.().catch(() => [page])) || [page];
      for (const p of pages) {
        if (!p || (typeof p.isClosed === 'function' && p.isClosed())) continue;
        const url = p.url?.() || '';
        if (isStripeCheckoutUrl(url)) {
          browser.__realPage = p;
          return focusPage(p, log);
        }
      }

      // Clique produtivo navega pro Stripe em ~2-3s. Se depois de 3.5s o CTA
      // do plano continua visivel, o clique nao iniciou checkout (ex.: abriu
      // so o modal) — aborta cedo pro poll re-clicar em vez de esperar 10s.
      if (Date.now() - start > 3500) {
        const ctaStillVisible = await page
          .evaluate(trialPlanOfferVisibleInPage)
          .catch(() => false);
        if (ctaStillVisible) {
          log?.debug?.(
            'CTA do plano ainda visivel apos clique — re-clicando sem esperar timeout.',
          );
          return null;
        }
      }
    } catch {
      /* noop */
    }
    await sleep(isProxyActive() ? 280 : 350);
  }
  return null;
}

/**
 * Clique atomico no CTA trial via DOM (evita mouse + infobar Chrome que fecha o X).
 */
async function clickTrialPlanOfferDom(page) {
  return page
    .evaluate(() => {
      /* eslint-disable no-undef */
      const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return false;
        const st = window.getComputedStyle(el);
        return (
          st.display !== 'none' &&
          st.visibility !== 'hidden' &&
          st.opacity !== '0'
        );
      };
      const isTrialBtn = (t) =>
        /solicitar\s+oferta\s+(de\s+\$0|gratuita|gr[aá]tis)/i.test(t) ||
        (t.includes('solicitar oferta') && /\$0|0\.00|0,00/.test(t)) ||
        (/experimente/.test(t) && /\$0|0\.00|gr[aá]tis/.test(t));

      window.scrollTo(0, 0);

      for (const el of document.querySelectorAll(
        '[data-testid="plan-cta-supergrok"]',
      )) {
        if (!isVisible(el)) continue;
        const label = norm(el.innerText || el.textContent || '');
        if (!isTrialBtn(label)) continue;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        el.click();
        return {
          ok: true,
          text: (el.innerText || '').trim().slice(0, 80),
          via: 'testid',
        };
      }

      const vh = window.innerHeight || 800;
      for (const el of document.querySelectorAll(
        'button, a, [role="button"]',
      )) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.top > vh * 0.85) continue; // ignora banner do rodape
        const label = norm(
          el.innerText || el.textContent || el.getAttribute('aria-label') || '',
        );
        if (!isTrialBtn(label)) continue;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        el.click();
        return { ok: true, text: label.slice(0, 80), via: 'button' };
      }
      return { ok: false };
      /* eslint-enable no-undef */
    })
    .catch(() => ({ ok: false }));
}

async function clickTrialPlanOfferButton(page, log, { browser } = {}) {
  await dismissSubscribeClickBlockers(page);
  await wakePage(page);

  let clicked = false;

  // 1) Mouse REAL no CTA (com verificacao elementFromPoint) — click() sintetico
  //    nao tem user-activation e o popup do Stripe pode ser bloqueado.
  if (await clickTrialPlanOfferViaMouse(page, log)) {
    clicked = true;
  }

  // 2) Clique DOM imediato como fallback.
  if (!clicked) {
    const domClick = await clickTrialPlanOfferDom(page);
    if (domClick?.ok) {
      log.info(
        `Plano trial clicado (${domClick.via}): ${domClick.text || 'Solicitar oferta de $0.00'}`,
      );
      clicked = true;
    }
  }

  if (!clicked && (await clickTrialPlanOfferBySelector(page, log))) {
    clicked = true;
  }

  if (!clicked) {
    const result = await page
      .evaluate(trialPlanOfferClickInPage, TRIAL_OFFER_SUBSTRINGS)
      .catch(() => ({ ok: false }));

    if (result?.ok) {
      log.info(
        `Plano trial clicado (dom): ${result.text || 'Solicitar oferta $0'}`,
      );
      clicked = true;
    }
  }

  // Ultimo recurso: clique DOM por texto (sem mouse / clickByTextReliable).
  if (!clicked) {
    const byText = await page
      .evaluate(() => {
        /* eslint-disable no-undef */
        const wants = [
          'solicitar oferta de $0.00',
          'solicitar oferta de $0',
          'solicitar oferta',
        ];
        for (const want of wants) {
          for (const el of document.querySelectorAll(
            'button, a, [role="button"]',
          )) {
            const label = (el.innerText || el.textContent || '')
              .trim()
              .toLowerCase();
            if (!label || !label.includes(want)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) continue;
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            el.click();
            return { ok: true, text: label.slice(0, 80) };
          }
        }
        return { ok: false };
        /* eslint-enable no-undef */
      })
      .catch(() => ({ ok: false }));
    if (byText?.ok) {
      log.info(`Plano trial clicado (texto): ${byText.text}`);
      clicked = true;
    }
  }

  if (!clicked) return false;

  if (browser) {
    let resolveStripeTab;
    const stripeTabPromise = new Promise((r) => {
      resolveStripeTab = r;
    });
    const tabTimer = setTimeout(() => resolveStripeTab(null), 10000);

    const onTarget = async (target) => {
      try {
        const p = await target.page();
        const url = p?.url?.() || '';
        if (p && isStripeCheckoutUrl(url)) {
          browser.__realPage = p;
          clearTimeout(tabTimer);
          browser.off('targetcreated', onTarget);
          resolveStripeTab(await focusPage(p, log));
        }
      } catch {
        /* noop */
      }
    };
    browser.on('targetcreated', onTarget);
    try {
      const stripePage = await Promise.race([
        waitForStripeAfterPlanClick(browser, page, log, 10000),
        stripeTabPromise,
      ]);
      if (stripePage) return { clicked: true, page: stripePage };
    } finally {
      clearTimeout(tabTimer);
      browser.off('targetcreated', onTarget);
    }
  }

  return { clicked: true, page };
}

async function advanceTrialPlanStep(page, sel, log, browser) {
  await dismissSubscribeClickBlockers(page);

  if (!(await isOnSubscribeOrPlanPage(page))) {
    log.debug('Fora da tela de planos — nao clicar (evita voltar pra home).');
    return { clicked: false, page };
  }

  const clickResult = await clickTrialPlanOfferButton(page, log, { browser });
  if (clickResult?.page) page = clickResult.page;
  if (clickResult?.clicked) {
    return {
      clicked: true,
      step: 'offer',
      text: 'Solicitar oferta de $0.00',
      page,
    };
  }

  return { clicked: false, page };
}

async function isStripeCheckoutUiReady(page) {
  // URL ja basta para nao ficar preso em "plano→stripe" com checkout aberto.
  try {
    if (isStripeCheckoutUrl(page.url?.() || '')) return true;
  } catch {
    /* noop */
  }

  return page
    .evaluate(() => {
      /* eslint-disable no-undef */
      const href = location.href || '';
      const onStripe =
        /checkout\.stripe\.com|stripe\.com\/(?:c\/)?pay|buy\.stripe|stripe\.com\/g\/pay/i.test(
          href,
        );
      if (onStripe) return true;

      // Layout atual (guacamole): shell externo com product-summary + iframe de pagamento.
      if (
        document.querySelector('[data-testid="checkout-container"]') ||
        document.querySelector('[data-testid="product-summary"]') ||
        document.querySelector('[data-testid="product-summary-name"]') ||
        document.querySelector('[data-testid="business-name"]')
      ) {
        return true;
      }

      const pixUi = !!document.querySelector(
        '[data-testid="pix-accordion-item-button"], #payment-method-accordion-item-title-pix, #payment-method-label-pix, input[value="pix"], input[type="radio"][value="pix"]',
      );
      const payments = !!document.querySelector(
        '[data-testid*="payment-method"], .PaymentMethodAccordion, [class*="PaymentMethod"], [data-testid="hosted-payment-submit-button"]',
      );
      const body = (document.body?.innerText || '').toLowerCase();
      const mentionsPix =
        body.includes('pix') || body.includes('pagar com pix');
      const mentionsCheckout =
        body.includes('iniciar teste') ||
        body.includes('start trial') ||
        body.includes('forma de pagamento') ||
        body.includes('payment method') ||
        body.includes('testar supergrok') ||
        body.includes('7 dias grátis') ||
        body.includes('7 dias gratis');
      return pixUi || payments || (mentionsPix && mentionsCheckout);
      /* eslint-enable no-undef */
    })
    .catch(() => false);
}

/**
 * Frames do formulario de pagamento Stripe (Pix/Cartao ficam no iframe habanero).
 * Com paymentFirst=true, tenta iframes antes da pagina externa (so tem resumo).
 */
function listStripePaymentContexts(page, { paymentFirst = false } = {}) {
  const iframes = [];
  try {
    for (const frame of page.frames?.() || []) {
      if (frame === page.mainFrame?.()) continue;
      const url = frame.url?.() || '';
      if (/currency-selector|elements-inner-currency/i.test(url)) continue;
      if (
        /elements-inner-habanero|elements-inner-payment|paymentForm|__privateStripeFrame/i.test(
          url,
        ) ||
        /js\.stripe\.com\/v3\/elements-inner/i.test(url)
      ) {
        iframes.push(frame);
      }
    }
  } catch {
    /* noop */
  }
  if (paymentFirst && iframes.length) return [...iframes, page];
  return [page, ...iframes];
}

/** Aguarda iframe habanero do formulario de pagamento carregar. */
async function waitForStripePaymentContexts(page, log, timeoutMs = 18000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const contexts = listStripePaymentContexts(page, { paymentFirst: true });
    if (contexts.length > 1) return contexts;

    const ready = await runInStripeContexts(page, async (ctx) => {
      return ctx
        .evaluate(() => {
          /* eslint-disable no-undef */
          const body = (document.body?.innerText || '').toLowerCase();
          return (
            !!document.querySelector(
              'input[type="email"], [data-testid="hosted-payment-submit-button"], input[type="radio"], [role="radio"]',
            ) ||
            body.includes('forma de pagamento') ||
            body.includes('payment method') ||
            body.includes('iniciar teste')
          );
          /* eslint-enable no-undef */
        })
        .catch(() => false);
    });
    if (ready) return contexts;
    await sleep(220);
  }
  log?.debug?.('Timeout aguardando iframe Stripe — tentando mesmo assim.');
  return listStripePaymentContexts(page, { paymentFirst: true });
}

async function runInStripeContexts(page, fn, { paymentFirst = false } = {}) {
  for (const ctx of listStripePaymentContexts(page, { paymentFirst })) {
    try {
      const result = await fn(ctx);
      if (result) return result;
    } catch {
      /* frame pode ter navegado */
    }
  }
  return false;
}

async function isOnTrialPlanScreen(page) {
  return page
    .evaluate(isOnTrialPlanScreenInPage, TRIAL_OFFER_SUBSTRINGS)
    .catch(() => false);
}

async function checkSubscribeProcessingError(page, log) {
  const err = await page
    .evaluate(
      dismissSubscribeProcessingErrorInPage,
      SUBSCRIBE_PROCESSING_ERROR_PATTERNS,
    )
    .catch(() => ({ hasError: false }));

  if (err?.hasError) {
    log.warn(`Grok recusou assinatura: ${err.message || 'erro ao processar'}`);
  }
  return err?.hasError ? err : null;
}

function subscribePlanRetryMs() {
  return Math.max(1000, config.subscribeErrorRetryMs || 10000);
}

/** Poll na tela de planos: clica "Solicitar oferta", espera 10s, repete ate Stripe abrir. */
async function pollThroughTrialPlanToStripe(
  browser,
  page,
  log,
  sel,
  { email = '', workerId = '', progress } = {},
) {
  const retryMs = subscribePlanRetryMs();
  const deadline = Date.now() + trialPlanToStripeWaitMs();
  let attempt = 0;
  let grokErrors = 0;
  let lastClickAt = 0;
  /** Uma vez visto checkout Stripe nesta conta, nao reabrir #subscribe nem re-clicar. */
  let seenStripe = false;
  const tag = email || '?';

  const syncProgress = () => {
    if (progress) {
      progress.subscribeAttempts = attempt;
      progress.subscribeGrokErrors = grokErrors;
    }
    subscribeActivityUpdate(email, {
      workerId,
      phase: 'plano→stripe',
      subscribeAttempts: attempt,
      subscribeGrokErrors: grokErrors,
    });
  };

  const markStripeIfNeeded = (p) => {
    try {
      if (isStripeCheckoutUrl(String(p?.url?.() || ''))) seenStripe = true;
    } catch {
      /* noop */
    }
  };

  while (Date.now() < deadline) {
    try {
      page = await resolveSubscribeFlowPage(browser, page, log);
      await focusPage(page, log);
      markStripeIfNeeded(page);


      if (await isStripeCheckoutUiReady(page)) {
        const trialStripe = await guardStripeTrialOrFail(page, browser, log);
        markStripeIfNeeded(trialStripe.page);
        if (!trialStripe.ok) {
          return {
            ok: false,
            page: trialStripe.page,
            subscribeAttempts: attempt,
            subscribeGrokErrors: grokErrors,
            reason: trialStripe.reason,
          };
        }
        if (attempt > 0)
          log.info(`Stripe trial aberto apos ${attempt} tentativa(s).`);
        return {
          ok: true,
          page: trialStripe.page,
          subscribeAttempts: attempt,
          subscribeGrokErrors: grokErrors,
        };
      }

      if (!(await isOnSubscribeOrPlanPage(page))) {
        // Ja vimos Stripe nesta conta: nao reabrir #subscribe (ping-pong).
        if (seenStripe) {
          page = await resolveStripeCheckoutPage(browser, page, log).catch(
            () => page,
          );
          markStripeIfNeeded(page);
          await sleep(400);
          continue;
        }
        // Logo apos um clique no CTA a pagina transiciona para o checkout
        // (DOM ainda vazio) — reaplicar o hash aqui puxava a instancia DE VOLTA
        // pro subscribe (ping-pong checkout→subscribe). Da carencia pro
        // checkout montar antes de reabrir o modal.
        if (lastClickAt && Date.now() - lastClickAt < 12000) {
          await sleep(400);
          continue;
        }
        // Fora da tela de planos (home ou hash "sujo") e sem clique recente:
        // reabre o modal via hash SPA com reset — sem reload.
        await openSubscribeHashIfOnGrokHome(page, { log, force: true });
        await sleep(400);
        continue;
      }

      if (await isPaidOnlySubscribePage(page)) {
        return {
          ok: false,
          page,
          subscribeAttempts: attempt,
          subscribeGrokErrors: grokErrors,
          reason: 'conta sem trial: tela de planos pagos ($10/$30/$99)',
        };
      }

      // Ja navegou pro Stripe: nao clicar de novo no CTA (evita voltar ao modal).
      if (seenStripe) {
        page = await resolveStripeCheckoutPage(browser, page, log).catch(
          () => page,
        );
        markStripeIfNeeded(page);
        await sleep(400);
        continue;
      }

      attempt += 1;
      syncProgress();
      log.info(
        `Plano trial: tentativa ${attempt} — clicando Solicitar oferta de $0.00...`,
      );
      log.summary(
        `SUBSCRIBE em andamento: ${tag} | clique plano ${attempt} | erros Grok ${grokErrors}`,
      );
      const step = await advanceTrialPlanStep(page, sel, log, browser);
      if (step?.page) page = step.page;
      if (step?.clicked) {
        lastClickAt = Date.now();
      } else {
        log.warn('Clique em Solicitar oferta falhou — tentando de novo...');
      }
      markStripeIfNeeded(page);

      // Sem erro do Grok, re-clica rapido (5s); erro "Algo deu errado" exige
      // cooldown cheio (retryMs) antes do proximo clique.
      let waitUntil = Math.min(Date.now() + Math.min(retryMs, 5000), deadline);
      while (Date.now() < waitUntil) {
        page = await resolveSubscribeFlowPage(browser, page, log).catch(
          () => page,
        );
        markStripeIfNeeded(page);

        if (await isStripeCheckoutUiReady(page)) {
          const trialStripe = await guardStripeTrialOrFail(page, browser, log);
          markStripeIfNeeded(trialStripe.page);
          if (!trialStripe.ok) {
            return {
              ok: false,
              page: trialStripe.page,
              subscribeAttempts: attempt,
              subscribeGrokErrors: grokErrors,
              reason: trialStripe.reason,
            };
          }
          log.info(`Stripe trial aberto apos tentativa ${attempt}.`);
          return {
            ok: true,
            page: trialStripe.page,
            subscribeAttempts: attempt,
            subscribeGrokErrors: grokErrors,
          };
        }

        const grokErr = await checkSubscribeProcessingError(page, log);
        if (grokErr) {
          grokErrors += 1;
          syncProgress();
          waitUntil = Math.min(Date.now() + retryMs, deadline);
          log.warn(
            `Grok recusou assinatura (tentativa ${attempt}, erro #${grokErrors}) — aguardando ${Math.round(retryMs / 1000)}s...`,
          );
          log.summary(
            `SUBSCRIBE erro Grok: ${tag} | clique plano ${attempt} | erro #${grokErrors} | retry ${Math.round(retryMs / 1000)}s`,
          );
        }

        await sleep(500);
      }
    } catch (e) {
      log?.debug?.(`Aguardando plano→Stripe: ${e.message}`);
      await sleep(1000);
    }
  }

  // Ultima chance: Stripe pode ter aberto em outra aba enquanto o poll olhava o Grok.
  page = await resolveSubscribeFlowPage(browser, page, log).catch(() => page);
  page = await resolveStripeCheckoutPage(browser, page, log).catch(() => page);

  if (
    (await isStripeCheckoutUiReady(page)) ||
    isStripeCheckoutUrl(page.url?.() || '')
  ) {
    log?.info?.(
      `Stripe detectado no fim do poll (${(page.url?.() || '').slice(0, 90)}) — seguindo.`,
    );
    const trialStripe = await guardStripeTrialOrFail(page, browser, log);
    if (trialStripe.ok) {
      return {
        ok: true,
        page: trialStripe.page,
        subscribeAttempts: attempt,
        subscribeGrokErrors: grokErrors,
      };
    }
    return {
      ok: false,
      page: trialStripe.page,
      subscribeAttempts: attempt,
      subscribeGrokErrors: grokErrors,
      reason: trialStripe.reason,
    };
  }

  if (await isOnTrialPlanScreen(page)) {
    return {
      ok: false,
      page,
      subscribeAttempts: attempt,
      subscribeGrokErrors: grokErrors,
      reason: `travado na selecao do plano trial (Stripe nao abriu apos ${attempt} tentativas)`,
    };
  }

  if (await isPaidOnlySubscribePage(page)) {
    return {
      ok: false,
      page,
      subscribeAttempts: attempt,
      subscribeGrokErrors: grokErrors,
      reason: 'conta sem trial: tela de planos pagos ($10/$30/$99)',
    };
  }

  const finalUrl = page.url?.() || '';
  log?.warn?.(
    `Timeout plano→Stripe sem checkout trial (url=${finalUrl.slice(0, 120)}) — abortando.`,
  );
  return {
    ok: false,
    page,
    subscribeAttempts: attempt,
    subscribeGrokErrors: grokErrors,
    reason: 'CTA trial $0.00 nao abriu Stripe',
  };
}

/** Espera extra pos-CTA quando ha muitas instancias (Stripe demora a abrir). */
function stripePostTrialDelayMs() {
  return Math.min(2000, 600 + config.concurrency * 120);
}

/** Tempo maximo na tela de planos trial antes do Stripe (varias tentativas de 10s). */
function trialPlanToStripeWaitMs() {
  if (config.trialPlanAdvanceMs > 0) return config.trialPlanAdvanceMs;
  const retryMs = subscribePlanRetryMs();
  const maxAttempts =
    config.subscribeErrorMaxRetries > 0 ? config.subscribeErrorMaxRetries : 12;
  return retryMs * maxAttempts + 12000;
}

/** Tempo maximo aguardando checkout Stripe + UI de pagamento. */
function stripeCheckoutWaitMs() {
  if (config.stripeCheckoutWaitMs > 0) return config.stripeCheckoutWaitMs;
  return Math.min(28000, 10000 + config.concurrency * 2000);
}

function pixSelectTimeoutMs() {
  if (config.stripePixSelectMs > 0) return config.stripePixSelectMs;
  // Layout radio Pix + Iniciar teste: nao ficar 15s+ preso.
  return Math.min(10000, 5000 + config.concurrency * 500);
}

/** Fecha sugestao de email do Stripe ("Voce quis dizer @...?") que atrapalha clique. */
async function dismissStripeEmailSuggestion(page) {
  await page
    .evaluate(() => {
      /* eslint-disable no-undef */
      for (const el of document.querySelectorAll(
        'button, a, [role="button"], span, div',
      )) {
        const t = (el.innerText || el.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        if (!t) continue;
        if (
          t.includes('você quis dizer') ||
          t.includes('voce quis dizer') ||
          t.includes('did you mean')
        ) {
          // Clicar fora / no proprio campo email para fechar o hint.
          const email = document.querySelector(
            'input[type="email"], input[name="email"]',
          );
          email?.focus?.();
          email?.blur?.();
          document.body?.click?.();
          return true;
        }
      }
      return false;
      /* eslint-enable no-undef */
    })
    .catch(() => false);
  try {
    await page.keyboard.press('Escape');
  } catch {
    /* noop */
  }
}

/** Aguarda aba Stripe e accordion de pagamento (PIX ou metodos) ficarem prontos. */
async function waitForStripeCheckoutReady(
  browser,
  page,
  log,
  timeoutMs = stripeCheckoutWaitMs(),
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      page = await resolveStripeCheckoutPage(browser, page, log);
      await focusPage(page, log);

      if (await isStripeCheckoutUiReady(page)) {
        log?.debug?.(`Stripe checkout pronto (${page.url().slice(0, 90)})`);
        return page;
      }
    } catch (e) {
      log?.debug?.(`Aguardando Stripe: ${e.message}`);
    }
    await sleep(220);
  }
  log?.warn?.(
    'Timeout aguardando Stripe checkout — tentando selecionar PIX mesmo assim.',
  );
  return resolveStripeCheckoutPage(browser, page, log);
}

async function scrollStripePixIntoView(ctx) {
  await ctx
    .evaluate(() => {
      /* eslint-disable no-undef */
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const pix =
        document.querySelector('[data-testid="pix-accordion-item-button"]') ||
        document.querySelector('#payment-method-accordion-item-title-pix') ||
        document.querySelector('#payment-method-label-pix') ||
        document.querySelector('input[type="radio"][value="pix"]') ||
        [...document.querySelectorAll('label')].find((l) => {
          const t = norm(l.innerText || l.textContent);
          return t === 'pix' || t.startsWith('pix ');
        });
      pix?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      /* eslint-enable no-undef */
    })
    .catch(() => {});
}

async function selectPixPayment(page, sel, log, browser) {
  const timeoutMs = Math.max(pixSelectTimeoutMs(), 12000);
  const start = Date.now();
  let active = page;

  while (Date.now() - start < timeoutMs) {
    if (browser) {
      active = await resolveStripeCheckoutPage(browser, active, log);
      await focusPage(active, log);
    }

    await waitForStripePaymentContexts(active, log, 4000);

    if (await isPixSelected(active)) {
      log.info('PIX selecionado (Stripe checkout / iframe).');
      return true;
    }

    const contexts = listStripePaymentContexts(active, { paymentFirst: true });
    log.debug?.(
      `Selecionando PIX: ${contexts.length} contexto(s) (${Math.max(0, contexts.length - 1)} iframe(s)).`,
    );

    for (const ctx of contexts) {
      await dismissStripeEmailSuggestion(ctx);
      await scrollStripePixIntoView(ctx);

      const strategies = [
        () => clickStripePixPaymentMethod(ctx),
        () => clickStripePixRadio(ctx),
        () => clickStripePixLabel(ctx),
        () => clickStripePixByTestId(ctx),
        () => clickAnyStripePixSelector(ctx, sel),
        () => clickStripePixByMouse(ctx),
      ];

      for (const strategy of strategies) {
        try {
          const clicked = await strategy();
          if (!clicked) continue;
          await sleep(350);
          if (await isPixSelected(active)) {
            log.info('PIX selecionado apos clique (Stripe / iframe).');
            return true;
          }
        } catch (err) {
          if (
            /detached|target closed|Execution context|acquireContextId|No frame with given id/i.test(
              err.message,
            ) &&
            browser
          ) {
            active = await resolveStripeCheckoutPage(browser, active, log);
            break;
          }
        }
      }
    }

    await sleep(200);
  }

  if (browser) active = await resolveStripeCheckoutPage(browser, active, log);
  for (const ctx of listStripePaymentContexts(active, { paymentFirst: true })) {
    const clicked = await clickByText(ctx, PIX_TEXTS, {
      timeout: 1500,
      poll: 80,
    }).catch(() => false);
    if (clicked) {
      await sleep(350);
      if (await isPixSelected(active)) {
        log.debug('PIX via texto (fallback iframe).');
        return true;
      }
    }
  }

  return false;
}

/**
 * Clica na linha "Pix" do layout radio (habanero iframe).
 * Usa mouse no centro do elemento — React/Stripe ignora click() sintetico as vezes.
 */
async function clickStripePixPaymentMethod(ctx) {
  try {
    const handle = await ctx.evaluateHandle(() => {
      /* eslint-disable no-undef */
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const pickTarget = (el) => {
        let target = el;
        for (let i = 0; i < 10 && target; i++) {
          const role = target.getAttribute?.('role');
          const tag = (target.tagName || '').toLowerCase();
          if (
            role === 'radio' ||
            tag === 'label' ||
            tag === 'button' ||
            target.getAttribute?.('tabindex') === '0' ||
            target.classList?.contains?.('PaymentMethod')
          ) {
            break;
          }
          target = target.parentElement;
        }
        return target || el;
      };

      for (const inp of document.querySelectorAll(
        'input[type="radio"][value="pix"], input[value="pix"]',
      )) {
        return pickTarget(inp.closest('label') || inp.parentElement || inp);
      }

      for (const r of document.querySelectorAll('[role="radio"]')) {
        const t = norm(r.innerText || r.textContent);
        const aria = norm(r.getAttribute('aria-label') || '');
        if (t === 'pix' || t.startsWith('pix\n') || aria === 'pix') {
          return pickTarget(r);
        }
      }

      for (const label of document.querySelectorAll('label')) {
        const t = norm(label.innerText || label.textContent);
        if (t === 'pix' || /^pix\b/.test(t)) {
          if (t.includes('cart')) continue;
          return pickTarget(label);
        }
      }

      for (const el of document.querySelectorAll('div, span, button')) {
        const t = norm(el.innerText || el.textContent);
        if (t !== 'pix') continue;
        if (el.children.length > 2) continue;
        return pickTarget(el);
      }

      return null;
      /* eslint-enable no-undef */
    });

    const el = handle.asElement?.();
    if (!el) {
      await handle.dispose?.().catch(() => {});
      return false;
    }

    await el.evaluate((node) =>
      node.scrollIntoView({ block: 'center', inline: 'nearest' }),
    );
    const box = await el.boundingBox();
    if (box && box.width > 4 && box.height > 4) {
      await ctx.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
        delay: 50,
      });
      await handle.dispose?.().catch(() => {});
      return true;
    }

    await el.click({ delay: 50 });
    await handle.dispose?.().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Clique imediato se o seletor existir — sem wait de 3.5s por seletor ausente. */
async function clickAnyStripePixSelector(page, sel) {
  const selectors = [sel.paymentPix, ...STRIPE_PIX_SELECTORS].filter(Boolean);
  const unique = [...new Set(selectors)];
  for (const selector of unique) {
    const handle = await page.$(selector).catch(() => null);
    if (!handle) continue;
    try {
      await handle.click({ delay: 20 });
      return true;
    } catch {
      const clicked = await page.evaluate((s) => {
        /* eslint-disable no-undef */
        const node = document.querySelector(s);
        if (!node) return false;
        node.click();
        return true;
        /* eslint-enable no-undef */
      }, selector);
      if (clicked) return true;
    }
  }
  return false;
}

/** Clica nos selectors oficiais do accordion Pix do Stripe. */
async function clickStripePixByTestId(page) {
  for (const selector of STRIPE_PIX_SELECTORS) {
    const handle = await page.$(selector);
    if (!handle) continue;
    try {
      await handle.click({ delay: 40 });
      return true;
    } catch {
      const clicked = await page.evaluate((s) => {
        /* eslint-disable no-undef */
        const node = document.querySelector(s);
        if (!node) return false;
        node.click();
        return true;
        /* eslint-enable no-undef */
      }, selector);
      if (clicked) return true;
    }
  }
  return false;
}

/** PIX selecionado = radio Pix marcado, accordion aberto, ou campos CPF visiveis. */
async function isPixSelected(page) {
  return runInStripeContexts(
    page,
    async (ctx) => {
      return ctx.evaluate(() => {
        /* eslint-disable no-undef */
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const body = norm(document.body?.innerText || '');

        if (
          body.includes('forma de pagamento obrigat') ||
          body.includes('payment method is required') ||
          body.includes('select a payment method')
        ) {
          return false;
        }

        const pixRadio = document.querySelector(
          '#payment-method-accordion-item-title-pix, input[value="pix"][name="payment-method-accordion-item-title"], input[type="radio"][value="pix"], input[value="pix"]',
        );
        if (pixRadio) {
          if (
            pixRadio.checked ||
            pixRadio.getAttribute('aria-checked') === 'true' ||
            pixRadio.getAttribute('aria-selected') === 'true'
          ) {
            return true;
          }
        }

        for (const r of document.querySelectorAll(
          'input[type="radio"], [role="radio"], [aria-checked]',
        )) {
          const id = (r.id || '').toLowerCase();
          const val = (r.value || '').toLowerCase();
          const aria = (r.getAttribute('aria-label') || '').toLowerCase();
          const labelFor = r.id
            ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`)
            : null;
          const labelText = norm(
            labelFor?.innerText || labelFor?.textContent || '',
          );
          let parentText = '';
          let p = r.parentElement;
          for (let i = 0; i < 5 && p; i++) {
            parentText = norm(p.innerText || p.textContent);
            if (parentText.includes('pix') || parentText.includes('cart'))
              break;
            p = p.parentElement;
          }
          const looksPix =
            val === 'pix' ||
            id.includes('pix') ||
            aria === 'pix' ||
            aria.includes('pix') ||
            labelText === 'pix' ||
            (parentText.includes('pix') && !parentText.includes('cart'));
          if (!looksPix) continue;
          if (
            r.checked ||
            r.getAttribute('aria-checked') === 'true' ||
            r.getAttribute('aria-selected') === 'true' ||
            r.classList?.contains?.('is-selected') ||
            r.classList?.contains?.('selected')
          ) {
            return true;
          }
        }

        const accordion = document.querySelector(
          '[data-testid="pix-accordion-item-button"][aria-expanded="true"], [data-testid="pix-accordion-item"][aria-expanded="true"]',
        );
        if (accordion) return true;

        for (const inp of document.querySelectorAll('input, textarea')) {
          const hay = [
            inp.name,
            inp.id,
            inp.placeholder,
            inp.getAttribute('aria-label'),
            inp.getAttribute('autocomplete'),
          ]
            .join(' ')
            .toLowerCase();
          if (
            hay.includes('cpf') ||
            hay.includes('cnpj') ||
            hay.includes('tax-id') ||
            hay.includes('taxid') ||
            hay.includes('nome do pagador')
          ) {
            const st = window.getComputedStyle(inp);
            if (
              st.display !== 'none' &&
              st.visibility !== 'hidden' &&
              inp.offsetParent !== null
            ) {
              return true;
            }
          }
        }

        return false;
        /* eslint-enable no-undef */
      });
    },
    { paymentFirst: true },
  );
}

/** Clica no label/linha "Pix" do radio (layout atual do Stripe BR). */
async function clickStripePixLabel(page) {
  return page.evaluate(() => {
    /* eslint-disable no-undef */
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const clickEl = (el) => {
      if (!el) return false;
      el.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      el.click();
      return true;
    };

    for (const label of document.querySelectorAll('label')) {
      const t = norm(label.innerText || label.textContent);
      if (t === 'pix' || t.startsWith('pix ') || /^pix\b/.test(t)) {
        if (t.includes('cart')) continue;
        const input =
          (label.htmlFor && document.getElementById(label.htmlFor)) ||
          label.querySelector('input[type="radio"], [role="radio"]');
        if (input) {
          input.click();
          label.click();
          return true;
        }
        return clickEl(label);
      }
    }

    for (const el of document.querySelectorAll(
      '[role="radio"], button, div[class*="PaymentMethod"], span',
    )) {
      const t = norm(el.innerText || el.textContent);
      if (t !== 'pix' && t !== 'pagar com pix') continue;
      return clickEl(el);
    }

    return false;
    /* eslint-enable no-undef */
  });
}

/** Clique real no centro do elemento Pix (Stripe accordion). */
async function clickStripePixByMouse(page) {
  const box = await page.evaluate(() => {
    /* eslint-disable no-undef */
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const hits = [];

    const tryAdd = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      if (rect.top < 0 || rect.left < 0) return;
      let node = el;
      for (let i = 0; i < 10 && node; i++) {
        const t = norm(node.innerText || node.textContent);
        if (t.includes('pix') && !t.includes('cart')) {
          hits.push({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            area: rect.width * rect.height,
            textLen: t.length,
          });
          break;
        }
        node = node.parentElement;
      }
    };

    for (const el of document.querySelectorAll(
      'input[type="radio"], [role="radio"], label, [role="button"], button, div, span',
    )) {
      tryAdd(el);
    }

    if (!hits.length) return null;
    // Preferir linha compacta "Pix" (accordion), nao o texto inteiro da pagina.
    hits.sort((a, b) => a.textLen - b.textLen || a.area - b.area);
    return hits[0];
    /* eslint-enable no-undef */
  });

  if (!box) return false;
  await page.mouse.click(box.x, box.y, { delay: 40 });
  return true;
}

async function clickStripePixRadio(page) {
  return page.evaluate(() => {
    /* eslint-disable no-undef */
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const radios = [
      ...document.querySelectorAll('input[type="radio"][value="pix"]'),
      ...document.querySelectorAll('input[type="radio"]'),
      ...document.querySelectorAll('[role="radio"]'),
    ];

    for (const r of radios) {
      const val = (r.value || '').toLowerCase();
      const id = (r.id || '').toLowerCase();
      if (val === 'pix' || id.includes('pix')) {
        r.click();
        r.dispatchEvent?.(new Event('change', { bubbles: true }));
        return true;
      }

      let el = r;
      for (let i = 0; i < 6 && el; i++) {
        const t = norm(el.innerText || el.textContent);
        if (t.includes('pix') && !t.includes('cart') && t.length < 80) {
          r.click();
          el.click();
          return true;
        }
        el = el.parentElement;
      }
    }
    return false;
    /* eslint-enable no-undef */
  });
}

async function detectPayerFieldsPresent(page) {
  return (
    (await runInStripeContexts(
      page,
      async (ctx) => {
        return ctx
          .evaluate(() => {
            /* eslint-disable no-undef */
            const visible = (el) => {
              if (!el) return false;
              const st = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return (
                st.display !== 'none' &&
                st.visibility !== 'hidden' &&
                el.offsetParent !== null &&
                rect.width > 8 &&
                rect.height > 8
              );
            };
            let hasCpf = false;
            let hasName = false;
            for (const inp of document.querySelectorAll('input, textarea')) {
              if (!visible(inp)) continue;
              const type = (inp.type || '').toLowerCase();
              if (
                type === 'email' ||
                type === 'hidden' ||
                type === 'radio' ||
                type === 'checkbox'
              ) {
                continue;
              }
              const ac = (inp.getAttribute('autocomplete') || '').toLowerCase();
              if (ac === 'email' || ac.startsWith('cc-')) continue;

              const hay = [
                inp.name,
                inp.id,
                inp.placeholder,
                inp.getAttribute('aria-label'),
                ac,
              ]
                .join(' ')
                .toLowerCase();

              if (
                inp.name === 'taxId' ||
                inp.id === 'taxId' ||
                ac === 'tax-id' ||
                hay.includes('cpf') ||
                hay.includes('cnpj') ||
                /000\.000\.000/.test(inp.placeholder || '')
              ) {
                hasCpf = true;
              }
              if (
                inp.name === 'name' ||
                ac === 'name' ||
                /nome completo|nome do pagador|full name/i.test(hay)
              ) {
                hasName = true;
              }
            }
            return hasCpf || hasName ? { hasCpf, hasName } : false;
            /* eslint-enable no-undef */
          })
          .catch(() => false);
      },
      { paymentFirst: true },
    )) || { hasCpf: false, hasName: false }
  );
}

/** Botao Iniciar teste / Revelar habilitado no iframe de pagamento. */
async function isStripeSubmitReady(page) {
  return runInStripeContexts(
    page,
    async (ctx) => {
      return ctx
        .evaluate(() => {
          /* eslint-disable no-undef */
          const btn =
            document.querySelector(
              '[data-testid="hosted-payment-submit-button"], button.SubmitButton[type="submit"]',
            ) ||
            [...document.querySelectorAll('button')].find((b) => {
              const t = (b.innerText || b.textContent || '').toLowerCase();
              return (
                t.includes('iniciar teste') ||
                t.includes('start trial') ||
                t.includes('revelar')
              );
            });
          if (!btn) return false;
          const t = (btn.innerText || btn.textContent || '').toLowerCase();
          return (
            !btn.disabled &&
            btn.getAttribute('aria-disabled') !== 'true' &&
            (t.includes('iniciar teste') ||
              t.includes('start trial') ||
              t.includes('revelar'))
          );
          /* eslint-enable no-undef */
        })
        .catch(() => false);
    },
    { paymentFirst: true },
  );
}

async function readPayerFieldState(page) {
  const best = {
    hasCpfField: false,
    hasNameField: false,
    cpfDigits: 0,
    nameLen: 0,
    cpf: '',
    name: '',
  };
  for (const ctx of listStripePaymentContexts(page, { paymentFirst: true })) {
    try {
      const s = await ctx.evaluate(() => {
        /* eslint-disable no-undef */
        const visible = (inp) => {
          if (!inp || inp.offsetParent === null) return false;
          const st = getComputedStyle(inp);
          return st.display !== 'none' && st.visibility !== 'hidden';
        };
        const read = (tokens, cssFirst = []) => {
          for (const sel of cssFirst) {
            const el = document.querySelector(sel);
            if (visible(el)) return { el, value: el.value || '' };
          }
          for (const inp of document.querySelectorAll('input, textarea')) {
            const hay = [
              inp.name,
              inp.id,
              inp.placeholder,
              inp.getAttribute('aria-label'),
              inp.getAttribute('autocomplete'),
            ]
              .join(' ')
              .toLowerCase();
            if (!tokens.some((token) => hay.includes(token))) continue;
            if (!visible(inp)) continue;
            return { el: inp, value: inp.value || '' };
          }
          return null;
        };

        const tax = read(
          ['taxid', 'cpf', 'cnpj', 'tax-id'],
          ['#taxId', 'input[name="taxId"]', 'input[autocomplete="tax-id"]'],
        );
        const name = read(
          ['nome', 'name', 'pagador'],
          ['input[name="name"]', 'input[autocomplete="name"]'],
        );
        const cpf = (tax?.value || '').replace(/\D/g, '');
        const nameVal = (name?.value || '').trim();
        return {
          hasCpfField: !!tax?.el,
          hasNameField: !!name?.el,
          cpfDigits: cpf.length,
          nameLen: nameVal.length,
          cpf,
          name: nameVal,
        };
        /* eslint-enable no-undef */
      });
      if (s) {
        best.hasCpfField = best.hasCpfField || s.hasCpfField;
        best.hasNameField = best.hasNameField || s.hasNameField;
        if (s.cpfDigits >= best.cpfDigits) {
          best.cpfDigits = s.cpfDigits;
          best.cpf = s.cpf || best.cpf;
        }
        if (s.nameLen >= best.nameLen) {
          best.nameLen = s.nameLen;
          best.name = s.name || best.name;
        }
      }
    } catch {
      /* frame pode ter navegado */
    }
  }
  return best;
}

/** Campos preenchidos E (quando payer informado) batendo com o pagador atual. */
function isPayerStateComplete(state, { hasCpf, hasName }, payer = null) {
  if (hasCpf && state.cpfDigits < 11) return false;
  if (hasName && state.nameLen < 3) return false;
  if (payer?.cpf && hasCpf && state.cpf && state.cpf !== payer.cpf) return false;
  if (payer?.name && hasName && state.name) {
    if (state.name.trim().toLowerCase() !== payer.name.trim().toLowerCase()) {
      return false;
    }
  }
  return true;
}

async function ensurePayerFieldsReady(page, sel, payer, payerFields, log) {
  return fillPayerFields(page, sel, payer, log, {
    requireCpf: payerFields.hasCpf,
    requireName: payerFields.hasName,
  });
}

/** Preenche nome + CPF num unico evaluate (sem alternar foco entre campos). */
async function fillPayerFieldsAtomic(
  ctx,
  payer,
  { requireCpf = true, requireName = true } = {},
) {
  return ctx.evaluate(
    ({ name, cpfMasked, cpf, requireCpf, requireName }) => {
      /* eslint-disable no-undef */
      const visible = (el) => {
        if (!el || el.disabled || el.readOnly) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        const st = window.getComputedStyle(el);
        return (
          st.display !== 'none' &&
          st.visibility !== 'hidden' &&
          st.opacity !== '0'
        );
      };

      const fieldHay = (inp) =>
        [
          inp.name,
          inp.id,
          inp.placeholder,
          inp.getAttribute('aria-label'),
          inp.getAttribute('autocomplete'),
        ]
          .join(' ')
          .toLowerCase();

      const setValue = (el, val) => {
        el.focus?.();
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: val,
          }),
        );
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      };

      const findCpfInput = () => {
        for (const inp of document.querySelectorAll('input')) {
          if (!visible(inp)) continue;
          const ac = (inp.getAttribute('autocomplete') || '').toLowerCase();
          const h = fieldHay(inp);
          if (
            inp.name === 'taxId' ||
            inp.id === 'taxId' ||
            ac === 'tax-id' ||
            h.includes('cpf') ||
            h.includes('cnpj') ||
            /000\.000\.000/.test(inp.placeholder || '')
          ) {
            return inp;
          }
        }
        return null;
      };

      const findNameInput = () => {
        for (const inp of document.querySelectorAll('input')) {
          if (!visible(inp)) continue;
          if (inp.name === 'taxId' || inp.id === 'taxId') continue;
          const ac = (inp.getAttribute('autocomplete') || '').toLowerCase();
          if (ac === 'tax-id' || ac.startsWith('cc-') || ac === 'email')
            continue;
          const type = (inp.type || '').toLowerCase();
          if (
            type === 'email' ||
            type === 'hidden' ||
            type === 'radio' ||
            type === 'checkbox'
          ) {
            continue;
          }
          const h = fieldHay(inp);
          if (
            inp.name === 'name' ||
            ac === 'name' ||
            /nome completo|nome do pagador|full name/i.test(h)
          ) {
            return inp;
          }
        }
        return null;
      };

      const cpfValue = (el) => (el?.value || '').replace(/\D/g, '');
      const nameValue = (el) => (el?.value || '').trim();
      const wantName = String(name || '').trim();

      const cpfEl = requireCpf ? findCpfInput() : null;
      const nameEl = requireName ? findNameInput() : null;

      // Sobrescreve se vazio OU se ainda tem CPF/nome do pagador anterior (pos-rotacao).
      if (
        nameEl &&
        (nameValue(nameEl).length < 3 ||
          nameValue(nameEl).toLowerCase() !== wantName.toLowerCase())
      ) {
        setValue(nameEl, wantName);
      }
      if (cpfEl && (cpfValue(cpfEl).length < 11 || cpfValue(cpfEl) !== cpf)) {
        setValue(cpfEl, cpfMasked);
        if (cpfValue(cpfEl).length < 11 || cpfValue(cpfEl) !== cpf) {
          setValue(cpfEl, cpf);
        }
      }

      const finalCpf = cpfValue(cpfEl);
      const finalName = nameValue(nameEl);
      return {
        nameOk:
          !requireName ||
          (finalName.length >= 3 &&
            finalName.toLowerCase() === wantName.toLowerCase()),
        cpfOk: !requireCpf || (finalCpf.length >= 11 && finalCpf === cpf),
        foundName: !!nameEl,
        foundCpf: !!cpfEl,
      };
      /* eslint-enable no-undef */
    },
    {
      name: payer.name,
      cpfMasked: payer.cpfMasked,
      cpf: payer.cpf,
      requireCpf,
      requireName,
    },
  );
}

async function fillPayerFields(
  page,
  sel,
  payer,
  log,
  { requireCpf = true, requireName = true } = {},
) {
  const payerOpts = { hasCpf: requireCpf, hasName: requireName };
  const maxRounds = 4;

  for (let round = 0; round < maxRounds; round++) {
    let state = await readPayerFieldState(page);
    if (isPayerStateComplete(state, payerOpts, payer)) {
      log.info(
        `Campos pagador: nome=ok cpf=ok${round ? ` (round ${round + 1})` : ''}`,
      );
      return true;
    }

    if (
      round === 0 &&
      (state.cpfDigits >= 11 || state.nameLen >= 3) &&
      !isPayerStateComplete(state, payerOpts, payer)
    ) {
      log.info(
        `Pagador no Stripe desatualizado (cpf=${state.cpf || '?'} nome="${state.name || ''}") — sobrescrevendo com ${payer.cpfMasked} / ${payer.name}`,
      );
    }

    for (const ctx of listStripePaymentContexts(page, { paymentFirst: true })) {
      const result = await fillPayerFieldsAtomic(ctx, payer, {
        requireCpf,
        requireName,
      });
      if (result.nameOk && result.cpfOk) {
        log.info(
          `Campos pagador: nome=ok cpf=ok (atomico, round ${round + 1})`,
        );
        return true;
      }
    }

    state = await readPayerFieldState(page);
    if (isPayerStateComplete(state, payerOpts, payer)) return true;

    const needName =
      requireName &&
      (state.nameLen < 3 ||
        !state.name ||
        state.name.trim().toLowerCase() !==
          String(payer.name || '')
            .trim()
            .toLowerCase());
    const needCpf =
      requireCpf &&
      (state.cpfDigits < 11 || !state.cpf || state.cpf !== payer.cpf);

    if (needName || needCpf) {
      log.debug(
        `Pagador incompleto/desatualizado (round ${round + 1}): nome=${state.nameLen} cpf=${state.cpfDigits}/11 — fallback teclado`,
      );
      const cpfSelectors = uniqueSelectors(
        sel.payerCpfInput,
        STRIPE_CPF_SELECTORS,
      );
      const nameSelectors = uniqueSelectors(
        sel.payerNameInput,
        STRIPE_NAME_SELECTORS,
      );
      for (const ctx of listStripePaymentContexts(page, {
        paymentFirst: true,
      })) {
        if (needName) {
          await fillStripeFieldKeyboard(ctx, nameSelectors, payer.name, {
            minLen: 3,
            matchText: payer.name,
          });
        }
        if (needCpf) {
          let cpfOk = await fillStripeFieldKeyboard(
            ctx,
            cpfSelectors,
            payer.cpfMasked,
            {
              digits: 11,
              matchDigits: payer.cpf,
            },
          );
          if (!cpfOk) {
            cpfOk = await fillStripeFieldKeyboard(
              ctx,
              cpfSelectors,
              payer.cpf,
              { digits: 11, matchDigits: payer.cpf },
            );
          }
        }
      }
    }

    await sleep(round < 2 ? 350 : 500);
  }

  const final = await readPayerFieldState(page);
  const ok = isPayerStateComplete(final, payerOpts, payer);
  log.info(
    `Campos pagador: nome=${final.nameLen >= 3 && (!payer?.name || final.name.trim().toLowerCase() === payer.name.trim().toLowerCase())} cpf=${final.cpfDigits}/11 match=${!payer?.cpf || final.cpf === payer.cpf}`,
  );
  return ok;
}

/** Digitacao no teclado — fallback quando o preenchimento atomico nao basta. */
async function fillStripeFieldKeyboard(
  page,
  selectors,
  value,
  { digits, minLen, matchDigits, matchText } = {},
) {
  if (!value) return false;
  const opts = {
    digits: digits || 0,
    minLen: minLen || 1,
    matchDigits: matchDigits ? String(matchDigits).replace(/\D/g, '') : '',
    matchText: matchText ? String(matchText).trim().toLowerCase() : '',
  };

  for (const selector of selectors) {
    const handle = await page.$(selector).catch(() => null);
    if (!handle) continue;

    try {
      const alreadyOk = await handle.evaluate((el, o) => {
        const v = el.value || '';
        if (o.digits) {
          const d = v.replace(/\D/g, '');
          if (d.length < o.digits) return false;
          if (o.matchDigits && d !== o.matchDigits) return false;
          return true;
        }
        if (o.minLen) {
          const t = v.trim();
          if (t.length < o.minLen) return false;
          if (o.matchText && t.toLowerCase() !== o.matchText) return false;
          return true;
        }
        return v.length > 0;
      }, opts);
      if (alreadyOk) return true;

      const viaJs = await handle.evaluate((el, val) => {
        el.focus?.();
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: val,
          }),
        );
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        return (el.value || '').length > 0;
      }, String(value));

      const matchesOpts = (el, o) => {
        const v = el.value || '';
        if (o.digits) {
          const d = v.replace(/\D/g, '');
          if (d.length < o.digits) return false;
          if (o.matchDigits && d !== o.matchDigits) return false;
          return true;
        }
        if (o.minLen) {
          const t = v.trim();
          if (t.length < o.minLen) return false;
          if (o.matchText && t.toLowerCase() !== o.matchText) return false;
          return true;
        }
        return v.length > 0;
      };

      if (viaJs) {
        const ok = await handle.evaluate(matchesOpts, opts);
        if (ok) return true;
      }

      await handle.evaluate((el) =>
        el.scrollIntoView({ block: 'center', inline: 'nearest' }),
      );
      await handle.click({ clickCount: 3, delay: 20 });
      await page.keyboard.press('Backspace');
      await page.keyboard.type(String(value), { delay: 12 });
      await handle.evaluate((el) => el.blur?.());
      await sleep(120);

      const ok = await handle.evaluate(matchesOpts, opts);
      if (ok) return true;
    } catch {
      /* proximo selector */
    }
  }
  return false;
}

async function waitForRevealButtonReady(page, log) {
  const start = Date.now();
  while (Date.now() - start < 12000) {
    if (!(await isPixSelected(page))) {
      await sleep(250);
      continue;
    }

    const ready = await runInStripeContexts(
      page,
      async (ctx) => {
        return ctx
          .evaluate(() => {
            /* eslint-disable no-undef */
            const tax = document.querySelector(
              '#taxId, input[name="taxId"], input[autocomplete="tax-id"], input[placeholder*="CPF" i]',
            );
            const name = document.querySelector(
              'input[name="name"], input[autocomplete="name"], input[placeholder*="Nome" i]',
            );
            const btn =
              document.querySelector(
                '[data-testid="hosted-payment-submit-button"], button.SubmitButton[type="submit"]',
              ) ||
              [...document.querySelectorAll('button')].find((b) => {
                const t = (b.innerText || b.textContent || '').toLowerCase();
                return (
                  t.includes('iniciar teste') ||
                  t.includes('start trial') ||
                  t.includes('revelar')
                );
              });
            const taxVisible =
              tax &&
              tax.offsetParent !== null &&
              getComputedStyle(tax).display !== 'none';
            const nameVisible =
              name &&
              name.offsetParent !== null &&
              getComputedStyle(name).display !== 'none';
            const cpfDigits = (tax?.value || '').replace(/\D/g, '').length;
            const nomeLen = (name?.value || '').trim().length;
            const btnText = (
              btn?.innerText ||
              btn?.textContent ||
              ''
            ).toLowerCase();
            const btnOk =
              btn &&
              !btn.disabled &&
              btn.getAttribute('aria-disabled') !== 'true' &&
              (btnText.includes('revelar') ||
                btnText.includes('iniciar teste') ||
                btnText.includes('start trial'));
            if (!btnOk) return false;
            if (!taxVisible && !nameVisible) return true;
            if (taxVisible && cpfDigits < 11) return false;
            if (nameVisible && nomeLen < 3) return false;
            return true;
            /* eslint-enable no-undef */
          })
          .catch(() => false);
      },
      { paymentFirst: true },
    );

    if (ready) {
      log.debug('Botao Revelar/Iniciar teste habilitado.');
      return true;
    }
    await sleep(250);
  }
  log.warn('Botao Revelar QR nao ficou pronto — tentando clicar mesmo assim.');
  return false;
}

async function clickRevealQrAndWait(page, browser, sel, log) {
  if (config.pixManualReveal) {
    log.info(
      'PIX_MANUAL_REVEAL=true — clique em "Revelar codigo QR" voce mesmo no browser.',
    );
    page = await waitForQrVisible(
      page,
      browser,
      log,
      config.pixGenerateWaitMs,
      { captureFlash: true },
    );
    if (!page) {
      const ui = await readStripeUiState(page);
      logStripeUiState(ui, log);
    }
    return page;
  }

  page = await resolveStripeCheckoutPage(browser, page, log);

  // QR ja visivel = nao clicar de novo (evita fechar o QR com duplo clique).
  if (await isQrCurrentlyVisible(page, browser, log)) {
    log.info('QR PIX ja visivel — pulando clique em Revelar.');
    return page;
  }

  const selector =
    sel.revealQr || '[data-testid="hosted-payment-submit-button"]';
  let clicked = false;

  if (!(await isPixSelected(page))) {
    log.warn('Iniciar teste bloqueado — PIX nao selecionado.');
    return null;
  }

  for (const ctx of listStripePaymentContexts(page, { paymentFirst: true })) {
    const handle = await ctx.$(selector).catch(() => null);
    if (!handle) {
      // Fallback: botao "Iniciar teste" no iframe novo.
      const byText = await clickByText(ctx, REVEAL_QR_TEXTS, {
        timeout: 800,
        poll: 60,
      }).catch(() => false);
      if (byText) {
        clicked = true;
        break;
      }
      continue;
    }

    const processing = await ctx
      .evaluate(() => {
        /* eslint-disable no-undef */
        return (
          document
            .querySelector('[data-testid="submit-button-processing-label"]')
            ?.getAttribute('aria-hidden') === 'false'
        );
        /* eslint-enable no-undef */
      })
      .catch(() => false);

    if (processing) {
      log.info('Stripe ja processando — aguardando QR sem novo clique.');
      clicked = true;
      break;
    }

    try {
      await handle.click({ delay: 50 });
      clicked = true;
      log.info(
        'Clicou em Revelar/Iniciar teste — aguardando QR ficar visivel...',
      );
      break;
    } catch {
      const ok = await ctx
        .evaluate((s) => {
          /* eslint-disable no-undef */
          document.querySelector(s)?.click();
          return !!document.querySelector(s);
          /* eslint-enable no-undef */
        }, selector)
        .catch(() => false);
      if (ok) {
        clicked = true;
        log.info(
          'Clicou em Revelar/Iniciar teste (evaluate) — aguardando QR...',
        );
        break;
      }
    }
  }

  if (!clicked) {
    log.warn('Botao Revelar/Iniciar teste nao encontrado (pagina + iframes).');
    return null;
  }

  page = await waitForQrVisible(page, browser, log, config.pixGenerateWaitMs, {
    captureFlash: true,
  });
  if (!page) {
    const stripePage = await resolveStripeCheckoutPage(browser, page, log);
    const ui = await readStripeUiState(stripePage);
    logStripeUiState(ui, log);
    const err = ui.alerts?.[0] || '';
    if (err) log.warn(`Stripe retornou erro: ${err.slice(0, 200)}`);
    return null;
  }

  return page;
}

async function isQrCurrentlyVisible(page, browser, log) {
  const ctx = await detectStripePixContext(browser, page, log);
  return ctx.state.hasPix;
}

/** Aguarda QR/EMV; enquanto Stripe processa, estende ate 3 min. */
async function waitForQrVisible(
  page,
  browser,
  log,
  timeoutMs,
  { captureFlash = false } = {},
) {
  const start = Date.now();
  let visibleStreak = 0;
  let lastLog = 0;
  const maxMs = Math.max(timeoutMs, 120000);

  while (Date.now() - start < maxMs) {
    if (browser && !(await isBrowserConnected(browser))) {
      log?.warn?.('Browser desconectado aguardando QR PIX.');
      return null;
    }

    page = await resolveStripeCheckoutPage(browser, page, log);

    const declinedEarly = await detectCardDeclinedError(page);
    if (declinedEarly) {
      log.warn(
        `Stripe recusou cartao/CPF enquanto aguardava QR: ${declinedEarly.slice(0, 160)}`,
      );
      return null;
    }

    const ctx = await detectStripePixContext(browser, page, log);
    const state = ctx.state;

    if (state.hasPix) {
      visibleStreak += 1;
      if (captureFlash && visibleStreak === 1) {
        log.info(
          `QR PIX detectado (${state.hasEmv ? 'EMV' : ''}${state.hasEmv && state.hasQrImg ? '+' : ''}${state.hasQrImg ? 'img' : ''}).`,
        );
      }
      if (visibleStreak >= (captureFlash ? 1 : 2)) {
        log.info('QR PIX visivel na tela.');
        return page;
      }
    } else {
      visibleStreak = 0;
    }

    const elapsed = Date.now() - start;
    if (!state.hasPix && elapsed > 12000) {
      const payer = await readPayerFieldState(page);
      if (
        (payer.hasCpfField && payer.cpfDigits < 11) ||
        (payer.hasNameField && payer.nameLen < 3)
      ) {
        log.warn('Travado na tela nome/CPF — abortando espera do QR.');
        return null;
      }
    }

    if (!state.processing && elapsed > timeoutMs) break;

    if (log && Date.now() - lastLog > 5000) {
      const sec = Math.round(elapsed / 1000);
      log.info(
        state.processing
          ? `Stripe processando... (${sec}s)`
          : `Aguardando QR... (${sec}s)`,
      );
      lastLog = Date.now();
    }

    await sleep(120);
  }
  return null;
}

function uniqueSelectors(...groups) {
  const all = groups.flatMap((g) =>
    (Array.isArray(g) ? g : String(g || '').split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return [...new Set(all)];
}

async function fillFirstMatchingInput(page, keywords, value) {
  return page.evaluate(
    (kws, val) => {
      /* eslint-disable no-undef */
      const inputs = Array.from(document.querySelectorAll('input, textarea'));
      for (const inp of inputs) {
        const hay = [
          inp.name,
          inp.id,
          inp.placeholder,
          inp.getAttribute('aria-label'),
          inp.getAttribute('autocomplete'),
        ]
          .join(' ')
          .toLowerCase();
        if (!kws.some((k) => hay.includes(k))) continue;
        const style = window.getComputedStyle(inp);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        inp.focus();
        inp.click();
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        if (setter) setter.call(inp, val);
        else inp.value = val;
        inp.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: val,
          }),
        );
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
      /* eslint-enable no-undef */
    },
    keywords,
    value,
  );
}

function fail(reason, extra = {}) {
  return {
    ok: false,
    reason,
    url: null,
    pix: null,
    subscribeAttempts: 0,
    subscribeGrokErrors: 0,
    ...extra,
  };
}

function safe(s) {
  return String(s || '')
    .replace(/[^a-z0-9]/gi, '_')
    .slice(0, 40);
}
