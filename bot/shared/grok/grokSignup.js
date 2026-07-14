import { config } from '../config.js';
import { effectiveNavTimeout, effectiveTrialCheckMs, isProxyActive } from '../proxy/proxy.js';
import { screenshot } from '../browser/browser.js';
import {
  solveTurnstileIfPresent,
  startBackgroundTurnstileSolver,
  stopBackgroundTurnstileSolver,
} from '../browser/turnstile.js';
import {
  dismissCookieBanner,
  dismissChromeOverlays,
  dismissPostLoginOverlays,
  gotoWithRetry,
  navigateToSubscribePage,
  ensureSubscribePageReady,
  sleep,
  wakePage,
} from '../browser/pageHelpers.js';
import {
  extractXaiVerificationCode,
  extractXaiVerifyLink,
  isValidXaiVerifyLink,
  waitForEmailHttp,
} from '../accounts/generatorEmail.js';
import {
  TRIAL_OFFER_SUBSTRINGS,
  TRIAL_UPGRADE_ONLY,
  evaluateTrialPageState,
  trialPlanOfferVisibleInPage,
  isPaidOnlySubscribePageInPage,
} from './trialOffer.js';

const POLL_MS = config.pollMs;
const NAV_TIMEOUT = config.navTimeout;

/**
 * Cadastra UMA conta nova no x.ai usando um email temporario do generator.email.
 * Reaproveita o solver de Turnstile do navegador real (puppeteer-real-browser).
 *
 * @param {object} page   pagina ja configurada (setupPage)
 * @param {object} account { email, password, firstName, lastName }
 * @returns {Promise<object>} { ok, reason, email, password, firstName, lastName, url }
 */
export async function signUpAccount(page, account, { proxy, log } = {}) {
  startBackgroundTurnstileSolver(page, log);
  try {
    return await signUpInner(page, account, { proxy, log });
  } finally {
    stopBackgroundTurnstileSolver(page, log);
  }
}

async function signUpInner(page, account, { log }) {
  const { email, password, firstName, lastName } = account;

  log.info(`Abrindo cadastro: ${config.signupUrl}`);
  await gotoWithRetry(page, config.signupUrl, { log });
  await wakePage(page);

  await waitForBodyText(page, /crie sua conta|create your account|cadastr|sign up/i, NAV_TIMEOUT).catch(() => {
    log.debug('Texto inicial de cadastro nao detectado (seguindo).');
  });
  await dismissCookieBanner(page);

  log.info('Selecionando "Cadastrar-se com e-mail".');
  await clickEmailSignup(page, log);

  const emailSel = await waitForAnySelector(
    page,
    ['input[name="email"]', 'input[type="email"]', 'input[autocomplete="email"]'],
    NAV_TIMEOUT,
  );
  if (!emailSel) {
    await screenshot(page, `signup-no-email-${safe(email)}`, log);
    return finish(page, false, 'campo de email nao encontrado no cadastro');
  }

  log.info(`Preenchendo email: ${email}`);
  await setInputValue(page, emailSel, email);
  await assertInputValue(page, emailSel, email, log);

  // Inicia o polling da inbox em paralelo (antes do submit)
  const emailPromise = waitForEmailHttp(email, {
    timeout: config.emailTimeoutMs,
    interval: config.performance.emailPollMs,
    subjectIncludes: 'xai',
    onKeepAlive: async () => {
      await page.evaluate(() => true).catch(() => {});
    },
    onPoll: (msg) => {
      const parts = [msg.subject ?? msg.code];
      if (msg.verifyLink) parts.push('link OK');
      log.info(`Email detectado: ${parts.filter(Boolean).join(' | ')}`);
    },
  });
  // evita unhandledRejection se o cadastro falhar antes do await
  emailPromise.catch(() => {});

  await solveSignupTurnstile(page, log, 'apos email');
  await clickSubmitSignup(page, log);
  log.info('Formulario de email enviado, aguardando tela de codigo...');

  try {
    await waitForVerificationStep(page, 8000);
  } catch {
    log.debug('Tela de codigo nao apareceu — tentando submit novamente.');
    await solveSignupTurnstile(page, log, 'retry email');
    await clickSubmitSignup(page, log).catch(() => {});
    await waitForVerificationStep(page, 10000);
  }

  log.info('Aguardando email de verificacao...');
  const message = await emailPromise;
  await wakePage(page);

  const verifyLink = message.verifyLink ?? extractXaiVerifyLink(message.html ?? message.text ?? '');
  const verifyCode =
    message.code ??
    extractXaiVerificationCode(message.subject) ??
    extractXaiVerificationCode(message.text) ??
    extractXaiVerificationCode(message.title);

  log.info(verifyLink ? 'Link de verificacao extraido.' : `Codigo OTP extraido: ${verifyCode}`);

  await completeEmailVerification(page, { verifyLink, verifyCode }, log);
  await completeRegistrationStep(page, { password, firstName, lastName }, log);

  const finalUrl = await waitForSignupSuccess(page, 30000);
  const ok = isSignupSuccessUrl(finalUrl);

  if (!ok) {
    const finalText = await getVisibleBodyText(page).catch(() => '');
    if (isXaiErrorPage(finalText)) {
      await screenshot(page, `signup-error-${safe(email)}`, log);
      return finish(page, false, 'x.ai exibiu erro ao finalizar o cadastro');
    }
    return finish(page, false, `cadastro nao confirmado (url: ${finalUrl})`);
  }

  log.info(`Cadastro concluido! URL final: ${finalUrl}`);
  return {
    ok: true,
    reason: 'cadastro ok',
    email,
    password,
    firstName,
    lastName,
    url: finalUrl,
  };
}

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

/** @deprecated use detectTrialOnSubscribePage */
async function checkTrialOnPlansPage(page, opts) {
  return detectTrialOnSubscribePage(page, opts);
}

/**
 * Verifica trial na HOME (login PIX e npm run generate).
 * Checagem estrita: $0.00 / grátis — nao recarrega se ja estiver em grok.com.
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
  if (await checkTrialOnPlansPage(page, { log })) {
    return true;
  }

  if (sawUpgrade) {
    log?.warn?.('Sem CTA $0 em #subscribe — conta SEM trial.');
  } else {
    log?.warn?.('Oferta trial ($0.00 / grátis) NAO aparece na home nem em #subscribe.');
  }
  return false;
}

async function solveSignupTurnstile(page, log, when) {
  const r = await solveTurnstileIfPresent(page, { log, waitMs: 3000 });
  if (r.skipped) {
    log.debug(`Sem Turnstile (${when}).`);
    return false;
  }
  if (r.solved) {
    log.info(`Turnstile resolvido (${when}).`);
    await sleep(150);
    return true;
  }
  log.warn(`Turnstile nao resolvido (${when}).`);
  return false;
}

// ---------------------------------------------------------------------------
// Etapas do cadastro
// ---------------------------------------------------------------------------

async function completeEmailVerification(page, { verifyLink, verifyCode }, log) {
  await wakePage(page);
  await assertNoXaiError(page);

  const link = verifyLink && isValidXaiVerifyLink(verifyLink) ? verifyLink : null;

  if (link) {
    log.info(`Verificando via link: ${link.slice(0, 80)}`);
    await gotoWithRetry(page, link, { log, retries: 2, timeout: NAV_TIMEOUT });
    await assertNoXaiError(page);
    await waitForPasswordStep(page, log);
    return;
  }

  if (!verifyCode) {
    throw new Error('Nao foi possivel extrair codigo ou link do email de verificacao');
  }

  log.info(`Verificando via codigo OTP: ${verifyCode}`);
  await enterVerificationCode(page, verifyCode, log);
  await waitForPasswordStep(page, log);
}

async function completeRegistrationStep(page, { password, firstName, lastName }, log) {
  await wakePage(page);
  await waitForAnySelector(page, ['input[type="password"]'], NAV_TIMEOUT);
  log.info('Tela "Complete seu cadastro" detectada.');

  await fillNameFields(page, firstName, lastName, log);
  log.info(`Nome preenchido: ${firstName} ${lastName}`);

  const pwdInputs = await page.$$('input[type="password"]');
  for (const input of pwdInputs) {
    const current = await input.evaluate((el) => el.value).catch(() => '');
    if (!current) await setInputValue(page, input, password);
  }
  log.info('Senha preenchida.');

  await solveSignupTurnstile(page, log, 'antes de finalizar');
  await clickCompleteRegistration(page, log);
  log.info('Formulario final enviado.');
}

async function waitForVerificationStep(page, timeout = 60000) {
  await wakePage(page);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await pageHasOtpInputs(page)) return;

    for (const selector of [
      'input[name="code"]',
      'input[name="otp"]',
      'input[autocomplete="one-time-code"]',
      'input[type="password"]',
    ]) {
      const el = await page.$(selector);
      if (el) return;
    }

    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/verif|confirme|c[oó]digo|code|check your email|enviamos|sent|confirmar e-mail|confirm email/i.test(text)) {
      return;
    }

    await sleep(POLL_MS);
  }

  throw new Error('Pagina de verificacao nao apareceu apos enviar o email');
}

async function pageHasOtpInputs(page) {
  return page.evaluate(() => {
    const isOtp = (el) => {
      if (el.type === 'password' || el.type === 'email' || el.type === 'hidden') return false;
      if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
      if (el.maxLength === 1) return true;
      if (el.getAttribute('autocomplete') === 'one-time-code') return true;
      if (/code|otp|token|digit/i.test(el.name ?? '')) return true;
      if (el.getAttribute('inputmode') === 'numeric') return true;
      return el.maxLength >= 6 && el.maxLength <= 8;
    };
    return [...document.querySelectorAll('input')].filter(isOtp).length >= 1;
  }).catch(() => false);
}

async function waitForOtpReady(page, timeout = 25000) {
  await wakePage(page);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const found = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input')].filter((el) => {
        if (el.type === 'password' || el.type === 'email' || el.type === 'hidden') return false;
        if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
        if (el.maxLength === 1) return true;
        if (el.getAttribute('autocomplete') === 'one-time-code') return true;
        if (/code|otp|token|digit/i.test(el.name ?? '')) return true;
        if (el.getAttribute('inputmode') === 'numeric') return true;
        if (el.getAttribute('data-index') != null) return true;
        return el.maxLength >= 6 && el.maxLength <= 8;
      });
      if (inputs.length >= 1) {
        inputs[0].scrollIntoView({ block: 'center' });
        return true;
      }
      return false;
    }).catch(() => false);

    if (found) return;

    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/ocorreu um erro|houve um erro|error occurred/i.test(text)) {
      throw new Error('x.ai exibiu erro na tela de verificacao');
    }

    await sleep(POLL_MS);
  }

  throw new Error('Campos OTP nao encontrados na pagina x.ai');
}

async function enterVerificationCode(page, code, log) {
  await wakePage(page);

  if (!code || typeof code !== 'string') {
    throw new Error(`Codigo invalido: ${code}`);
  }

  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  log.info(`Preenchendo codigo: ${normalized} (${normalized.length} chars)`);

  await waitForOtpReady(page);

  const filled = await fillOtpInputs(page, normalized);
  if (!filled) {
    throw new Error('Nao foi possivel preencher os campos OTP');
  }

  await waitForOtpResult(page, log);
}

async function fillOtpInputs(page, code) {
  const otpInputs = await findOtpInputs(page);

  if (otpInputs.length === 1) {
    await setInputValue(page, otpInputs[0], code);
    return true;
  }

  if (otpInputs.length >= code.length) {
    await otpInputs[0].click();
    await page.keyboard.type(code, { delay: 0 });
    return true;
  }

  const first = await page.$('input[autocomplete="one-time-code"], input[name="code"], input[name="otp"]');
  if (first) {
    await setInputValue(page, first, code);
    return true;
  }

  return false;
}

async function waitForOtpResult(page, log, timeout = 20000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const state = await readPageState(page);

    if (isXaiErrorPage(state.text)) {
      if (await recoverAfterVerify(page, log)) return;
      throw new Error('x.ai exibiu erro apos informar o codigo');
    }

    if (/invalid input|expected string|inv[aá]lido|incorrect|c[oó]digo inv[aá]lido|invalid code/i.test(state.text)) {
      throw new Error('Codigo de verificacao rejeitado pela x.ai');
    }

    if (state.hasPassword || /complete seu cadastro|complete your registration/i.test(state.text)) {
      return;
    }

    if (state.otpCount === 0 && !state.hasOtpLike) {
      await sleep(150);
      const recheck = await readPageState(page);
      if (isXaiErrorPage(recheck.text)) {
        throw new Error('x.ai exibiu erro apos informar o codigo');
      }
      if (recheck.hasPassword || /complete seu cadastro|complete your registration/i.test(recheck.text)) {
        return;
      }
    }

    await sleep(POLL_MS);
  }

  await clickByLabels(page, ['confirmar e-mail', 'confirm email']).catch(() => {});
  await assertNoXaiError(page);
}

async function readPageState(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const otpLike = [...document.querySelectorAll('input')].filter((el) => {
      if (el.type === 'password' || el.type === 'email' || el.type === 'hidden') return false;
      if (!isVisible(el)) return false;
      return el.maxLength === 1 || el.getAttribute('autocomplete') === 'one-time-code';
    });

    return {
      text: document.body.innerText,
      otpCount: otpLike.length,
      hasOtpLike: otpLike.length > 0,
      hasPassword: !!document.querySelector('input[type="password"]'),
    };
  }).catch(() => ({ text: '', otpCount: 0, hasOtpLike: false, hasPassword: false }));
}

async function findOtpInputs(page) {
  const indices = await page.evaluate(() => {
    const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const isOtp = (el) => {
      if (el.type === 'password' || el.type === 'email' || el.type === 'hidden') return false;
      if (!isVisible(el)) return false;
      if (el.maxLength === 1) return true;
      if (el.getAttribute('autocomplete') === 'one-time-code') return true;
      if (/code|otp|token|digit/i.test(el.name ?? '')) return true;
      if (/code|otp|digit/i.test(el.id ?? '')) return true;
      if (el.getAttribute('inputmode') === 'numeric') return true;
      if (el.getAttribute('data-index') != null) return true;
      return el.maxLength >= 6 && el.maxLength <= 8;
    };

    const all = [...document.querySelectorAll('input')];
    const otpInputs = all.filter(isOtp);

    if (otpInputs.length === 1) return [all.indexOf(otpInputs[0])];

    if (otpInputs.length >= 6) {
      return otpInputs
        .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
        .slice(0, 6)
        .map((el) => all.indexOf(el));
    }

    const singleChar = all.filter((el) => isVisible(el) && el.maxLength === 1);
    if (singleChar.length >= 6) {
      return singleChar
        .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
        .slice(0, 6)
        .map((el) => all.indexOf(el));
    }

    return [];
  });

  const allHandles = await page.$$('input');
  return indices.map((i) => allHandles[i]).filter(Boolean);
}

async function waitForPasswordStep(page, log) {
  await assertNoXaiError(page);

  const found = await waitForAnySelector(page, ['input[type="password"]'], 20000);
  if (found) {
    log.info('Tela de cadastro (senha) detectada.');
    return;
  }

  const text = await getVisibleBodyText(page);
  if (/complete seu cadastro|complete your registration|verified|verificado|senha|password/i.test(text)) {
    await waitForAnySelector(page, ['input[type="password"]'], 10000);
    return;
  }
  if (isXaiErrorPage(text)) {
    throw new Error('x.ai exibiu erro em vez da tela de cadastro');
  }
  throw new Error('Tela de cadastro nao apareceu apos confirmar o codigo');
}

async function waitForSignupSuccess(page, timeout = 30000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    let url = '';
    try {
      url = page.url();
    } catch {
      await sleep(POLL_MS);
      continue;
    }

    if (isSignupSuccessUrl(url)) return url;

    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 800 });
    } catch {
      // mesma pagina ou navegacao lenta
    }

    await sleep(POLL_MS);
  }

  try {
    return page.url();
  } catch {
    return '';
  }
}

async function recoverAfterVerify(page, log) {
  log.debug('Erro pos-verificacao — tentando recuperar o fluxo.');

  const attempts = [
    async () => {
      await clickByLabels(page, ['tentar novamente', 'try again']);
      await sleep(400);
    },
    async () => {
      await gotoWithRetry(page, config.signupUrl, { log, retries: 1, timeout: NAV_TIMEOUT });
      await sleep(400);
    },
  ];

  for (const attempt of attempts) {
    try {
      await attempt();
    } catch {
      continue;
    }

    const state = await readPageState(page);
    if (state.hasPassword || /complete seu cadastro|complete your registration|nome|sobrenome|senha|password/i.test(state.text)) {
      log.info('Fluxo recuperado — tela de cadastro disponivel.');
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Helpers de pagina (portados/adaptados do projeto grok)
// ---------------------------------------------------------------------------

async function clickEmailSignup(page, log) {
  await wakePage(page);
  await dismissCookieBanner(page);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const clicked = await page.evaluate(() => {
      const elements = [...document.querySelectorAll('button, a, [role="button"]')];
      const target = elements.find((el) => {
        const text = el.textContent?.trim().toLowerCase() ?? '';
        const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        if (!visible) return false;
        if (text.includes(' com x') || text.includes('with x')) return false;
        if (text.includes('apple') || text.includes('google')) return false;
        return text.includes('e-mail') || text.includes('email');
      });
      if (!target) return false;
      target.scrollIntoView({ block: 'center' });
      target.click();
      return true;
    }).catch(() => false);

    if (clicked) {
      const sel = await waitForAnySelector(
        page,
        ['input[name="email"]', 'input[type="email"]', 'input[autocomplete="email"]'],
        10000,
      );
      if (sel) return;
    }

    if (attempt < 3) {
      log.debug(`Formulario de email nao abriu (tentativa ${attempt}/3).`);
      await dismissCookieBanner(page);
    }
  }

  // fallback: talvez o campo de email ja esteja visivel
  const sel = await waitForAnySelector(
    page,
    ['input[name="email"]', 'input[type="email"]', 'input[autocomplete="email"]'],
    3000,
  );
  if (!sel) throw new Error('Botao/campo "Cadastrar-se com e-mail" nao encontrado');
}

async function clickSubmitSignup(page, log) {
  await wakePage(page);

  const clicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button[type="submit"], button')];
    const target = buttons.find((el) => {
      const text = el.textContent?.trim().toLowerCase() ?? '';
      if (!el.offsetParent) return false;
      if (text.includes(' com x') || text.includes('with x')) return false;
      if (text.includes('apple') || text.includes('google')) return false;
      if (text === 'voltar' || text === 'back') return false;
      return text === 'cadastrar-se' || text === 'sign up' || text === 'continuar' || text === 'continue';
    });
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  }).catch(() => false);

  if (!clicked) {
    log?.debug?.('Submit por texto falhou — tentando Enter.');
    await page.keyboard.press('Enter').catch(() => {});
  }
  await dismissChromeOverlays(page);
}

async function clickCompleteRegistration(page, log, timeout = 20000) {
  await wakePage(page);

  const labels = [
    'completar cadastro',
    'complete registration',
    'complete signup',
    'complete sign-up',
    'finish signing up',
    'criar conta',
    'create account',
    'sign up',
    'cadastrar-se',
    'continuar',
    'continue',
  ];

  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const clicked = await page.evaluate((texts) => {
      const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const isSocial = (text) =>
        text.includes(' com x') || text.includes('with x') || text.includes('apple') || text.includes('google');

      const candidates = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')];

      for (const label of texts) {
        const match = candidates.find((el) => {
          if (!isVisible(el) || el.disabled) return false;
          const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
          if (isSocial(text)) return false;
          if (text === 'voltar' || text === 'back') return false;
          return text.includes(label);
        });
        if (match) {
          match.scrollIntoView({ block: 'center' });
          match.click();
          return label;
        }
      }

      const pwd = document.querySelector('input[type="password"]');
      if (pwd) {
        const form = pwd.closest('form');
        if (form) {
          const submit = form.querySelector('button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled])');
          if (submit && isVisible(submit)) {
            submit.scrollIntoView({ block: 'center' });
            submit.click();
            return 'form-submit';
          }
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
            return 'form-requestSubmit';
          }
        }
      }

      return null;
    }, labels).catch(() => null);

    if (clicked) {
      log?.debug?.(`Cadastro finalizado via: ${clicked}`);
      return clicked;
    }

    await sleep(POLL_MS);
  }

  log?.debug?.('Botao de finalizar nao encontrado — tentando Enter.');
  await page.keyboard.press('Enter').catch(() => {});
  return null;
}

async function clickByLabels(page, labels) {
  return page.evaluate((texts) => {
    const elements = [...document.querySelectorAll('button, a, [role="button"]')];
    for (const label of texts) {
      const match = elements.find((el) => {
        const text = el.textContent?.trim().toLowerCase() ?? '';
        return text.includes(label.toLowerCase()) && el.offsetParent !== null;
      });
      if (match) {
        match.scrollIntoView({ block: 'center' });
        match.click();
        return true;
      }
    }
    return false;
  }, labels).catch(() => false);
}

async function fillNameFields(page, firstName, lastName, log) {
  const firstSelectors = ['input[name="firstName"]', 'input[name="first_name"]', 'input[autocomplete="given-name"]'];
  const lastSelectors = ['input[name="lastName"]', 'input[name="last_name"]', 'input[autocomplete="family-name"]'];

  let filledFirst = false;
  let filledLast = false;

  for (const selector of firstSelectors) {
    if (await page.$(selector)) {
      await setInputValue(page, selector, firstName);
      filledFirst = true;
      break;
    }
  }

  for (const selector of lastSelectors) {
    if (await page.$(selector)) {
      await setInputValue(page, selector, lastName);
      filledLast = true;
      break;
    }
  }

  if (filledFirst && filledLast) return;

  const textInputs = [];
  for (const handle of await page.$$('input')) {
    const info = await handle.evaluate((el) => ({
      visible: !!(el.offsetWidth || el.offsetHeight),
      type: el.type,
      readOnly: el.readOnly,
    })).catch(() => ({ visible: false }));

    if (info.visible && !info.readOnly && info.type !== 'password' && info.type !== 'email' && info.type !== 'hidden') {
      textInputs.push(handle);
    }
  }

  if (!filledFirst && textInputs[0]) await setInputValue(page, textInputs[0], firstName);
  if (!filledLast && textInputs[1]) await setInputValue(page, textInputs[1], lastName);

  if (!textInputs.length) log?.debug?.('Nenhum campo de nome encontrado.');
}

/**
 * Confirma que o valor no input bate com o esperado; re-preenche uma vez se
 * caracteres foram perdidos (o solver de Turnstile pode roubar o foco).
 */
async function assertInputValue(page, selector, expected, log, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    const actual = await page.$eval(selector, (el) => el.value).catch(() => '');
    if (actual === expected) return;
    log?.debug?.(`Valor divergente ("${actual}" != "${expected}") — re-preenchendo (${i + 1}/${attempts}).`);
    await setInputValue(page, selector, expected);
    await sleep(80);
  }
  const finalVal = await page.$eval(selector, (el) => el.value).catch(() => '');
  if (finalVal !== expected) {
    log?.warn?.(`Campo pode estar incompleto: "${finalVal}" (esperado "${expected}").`);
  }
}

async function setInputValue(page, target, value) {
  await wakePage(page);

  const applyValue = (el, val) => {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  if (typeof target === 'string') {
    await page.waitForSelector(target, { visible: true });
    await page.$eval(target, applyValue, value);
    return;
  }

  await target.evaluate(applyValue, value);
}

async function waitForAnySelector(page, selectors, timeout = NAV_TIMEOUT) {
  await wakePage(page);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const el = await page.$(selector);
      if (el && (await el.isIntersectingViewport().catch(() => true))) {
        return selector;
      }
    }
    await sleep(POLL_MS);
  }

  return null;
}

async function waitForBodyText(page, pattern, timeout = 60000) {
  await wakePage(page);
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (regex.test(text)) return text;
    await sleep(POLL_MS);
  }

  throw new Error(`Timeout aguardando texto: ${regex}`);
}

async function getVisibleBodyText(page) {
  return page.evaluate(() => document.body.innerText).catch(() => '');
}

function isSignupSuccessUrl(url) {
  return /accounts\.x\.ai\/account|grok\.com/i.test(url ?? '');
}

function isXaiErrorPage(text) {
  return /ocorreu um erro|houve um erro|error occurred|something went wrong/i.test(text ?? '');
}

async function assertNoXaiError(page) {
  const text = await getVisibleBodyText(page);
  if (isXaiErrorPage(text)) {
    const recovered = await clickByLabels(page, ['tentar novamente', 'try again']);
    await sleep(300);
    const after = await getVisibleBodyText(page);
    if (!recovered || isXaiErrorPage(after)) {
      throw new Error('x.ai exibiu erro durante o cadastro');
    }
  }
}

function finish(page, ok, reason, extra = {}) {
  let url = '';
  try {
    url = page.url();
  } catch {
    /* noop */
  }
  return { ok, reason, url, ...extra };
}

function safe(s) {
  return String(s || '').replace(/[^a-z0-9]/gi, '_').slice(0, 40);
}
