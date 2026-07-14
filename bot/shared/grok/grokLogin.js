import { config } from '../config.js';
import { isInvalidLoginCredentials } from '../accounts/accounts.js';
import { screenshot, ensureLoggedOut } from '../browser/browser.js';
import {
  solveTurnstileIfPresent,
  startBackgroundTurnstileSolver,
  stopBackgroundTurnstileSolver,
} from '../browser/turnstile.js';
import {
  setInputValue,
  assertInputValue,
  clickAny,
  clickByText,
  openEmailLoginForm,
  ensureEmailLoginFormReady,
  waitForEmailLoginForm,
  isEmailProviderScreen,
  isEmailInputVisible,
  recoverEmailLoginFormIfNeeded,
  dismissCookieBanner,
  dismissChromeOverlays,
  waitForAnySelector,
  waitForLoggedIn,
  hasTurnstileToken,
  turnstileLooksSolved,
  hasTurnstile,
  hasTurnstileFrame,
  waitForTurnstileSolved,
  clickElementReliable,
  isNavigationError,
  safePageUrl,
  gotoWithRetry,
  sleep,
  wakePage,
  isLoggedInUrl,
} from '../browser/pageHelpers.js';
import { effectiveLoginPostSubmitMs, effectiveLoginPollMs, effectiveLoginSelectorTimeout, effectiveNavTimeout, isProxyActive, isConnectionError } from '../proxy/proxy.js';
import { isTrialOfferAvailable } from './grokSignup.js';

/**
 * Executa o fluxo de login em uma conta Grok ja existente.
 * Assume uma pagina ja configurada (setupPage).
 */
export async function loginGrok(page, account, { proxy, log, freshProfile } = {}) {
  const sel = config.selectors;
  startBackgroundTurnstileSolver(page, log);

  try {
    return await loginGrokInner(page, account, { proxy, log, sel, captchaRefreshAttempt: 0, freshProfile });
  } catch (err) {
    if (isNavigationError(err)) {
      log.warn('Navegacao interrompeu o login — verificando sessao...');
      if (await isLoggedInSafe(page)) {
        return await finishWithTrialCheck(page, log, true, 'login ok');
      }
      return finish(page, false, 'login interrompido por redirect (proxy lenta)');
    }
    throw err;
  } finally {
    stopBackgroundTurnstileSolver(page, log);
  }
}

async function loginGrokInner(page, account, { proxy, log, sel, captchaRefreshAttempt = 0, freshProfile = false }) {
  const formTimeout = effectiveLoginSelectorTimeout();
  const navTimeout = effectiveNavTimeout();
  const cookieTimeout = isProxyActive() ? 700 : 1200;

  let formReady = await ensureEmailLoginFormReady(page, sel.emailInput, { log, formTimeout });
  if (!formReady) {
    formReady = await recoverEmailLoginFormIfNeeded(page, sel.emailInput, {
      log,
      accountEmail: account.email,
      formTimeout,
    });
  }
  await wakePage(page);
  if (formReady) {
    log.info(`Formulario email pronto (${page.url().slice(0, 80)})`);
  } else {
    log.warn('Formulario de email nao abriu apos tentativas.');
  }

  await waitForAnySelector(page, `${sel.emailInput}, button, [role="button"]`, {
    timeout: Math.min(formTimeout, 8000),
  });

  if (!freshProfile && (await isLoggedIn(page))) {
    log.warn('Sessao antiga detectada — forcando logout antes do login.');
    await ensureLoggedOut(page, log);
    await ensureEmailLoginFormReady(page, sel.emailInput, { log, formTimeout });
    await waitForAnySelector(page, `${sel.emailInput}, button, [role="button"]`, {
      timeout: Math.min(formTimeout, 8000),
    });
    if (await isLoggedIn(page)) {
      log.warn('Sessao antiga persiste — feche janelas Chrome antigas do grokPix.');
      return finish(page, false, 'sessao antiga nao removida (feche browsers antigos)');
    }
  }

  let emailEl = await page.$(sel.emailInput);
  if (!emailEl && !formReady) {
    const formStart = Date.now();
    const opened = await openEmailLoginForm(page, sel.emailInput, {
      timeout: Math.min(formTimeout, 6000),
      log,
    });
    if (opened) {
      log.info(`Formulario email aberto em ${Date.now() - formStart}ms`);
      emailEl = await page.$(sel.emailInput);
    } else {
      log.warn('Formulario de email nao abriu.');
    }
  }

  const cookie = await dismissCookieBanner(page, { timeout: 400 });
  if (cookie) {
    log.debug('banner de cookies dispensado.');
    await sleep(isProxyActive() ? 40 : 80);
  }

  emailEl = emailEl || (await waitForAnySelector(page, sel.emailInput, { timeout: formTimeout }));
  if (!emailEl || !(await isEmailInputVisible(page, sel.emailInput))) {
    log.warn('Campo email invisivel — reabrindo formulario.');
    await ensureEmailLoginFormReady(page, sel.emailInput, { log, formTimeout });
    emailEl = await waitForAnySelector(page, sel.emailInput, { timeout: formTimeout });
  }
  if (!emailEl || !(await isEmailInputVisible(page, sel.emailInput))) {
    await screenshot(page, `no-email-${safe(account.email)}`, log);
    return finish(page, false, 'campo de email nao encontrado');
  }

  log.info(`Preenchendo email: ${account.email}`);
  await setInputValue(page, sel.emailInput, account.email, { selectorTimeout: formTimeout });
  await assertInputValue(page, sel.emailInput, account.email, { log, attempts: 1 });

  await recoverEmailLoginFormIfNeeded(page, sel.emailInput, {
    log,
    accountEmail: account.email,
    formTimeout,
  });

  let passEl = await waitForAnySelector(page, sel.passwordInput, { timeout: 200 });
  const singlePage = !!passEl;

  if (!singlePage) {
    log.info('Avancando para etapa de senha (Proximo)...');
    await clickEmailNext(page, sel, log, account);

    passEl = await waitForAnySelector(page, sel.passwordInput, { timeout: formTimeout });
    if (!passEl) {
      await recoverEmailLoginFormIfNeeded(page, sel.emailInput, {
        log,
        accountEmail: account.email,
        formTimeout,
      });
      await dismissCookieBanner(page, { timeout: cookieTimeout }).catch(() => {});
      if (!(await turnstileLooksSolved(page))) {
        await maybeSolveTurnstile(page, { proxy, log }, 'bloqueio apos proximo', { waitMs: 400 });
      }
      await clickEmailNext(page, sel, log, account);
      passEl = await waitForAnySelector(page, sel.passwordInput, { timeout: navTimeout });
    }
    if (!passEl) {
      if (await isLoggedInSafe(page)) return finish(page, true, 'logado sem etapa de senha');
      await screenshot(page, `no-password-${safe(account.email)}`, log);
      return finish(page, false, 'campo de senha nao encontrado (email invalido ou fluxo mudou?)', {
        invalidCredentials: true,
      });
    }
  } else {
    log.debug('Formulario de pagina unica (email + senha juntos).');
  }

  log.info('Preenchendo senha');
  await setInputValue(page, sel.passwordInput, account.password, { selectorTimeout: formTimeout });
  await assertInputValue(page, sel.passwordInput, account.password, {
    log,
    attempts: isProxyActive() ? 1 : 2,
  });

  await wakePage(page);

  if (await submitLoginWhenTurnstileReady(page, sel, log, { proxy, account })) {
    await dismissCookieBanner(page, { timeout: 5000 }).catch(() => {});
    await dismissChromeOverlays(page);
    return await finishWithTrialCheck(page, log, true, 'login ok');
  }

  const captchaStillPresent =
    (await hasTurnstile(page).catch(() => false)) || hasTurnstileFrame(page);
  if (
    captchaStillPresent &&
    !(await hasTurnstileToken(page)) &&
    !(await turnstileLooksSolved(page))
  ) {
    return retryAfterTurnstileFailure(page, account, {
      proxy,
      log,
      sel,
      captchaRefreshAttempt,
      reason: 'turnstile nao resolvido antes do submit (tentar IP novo)',
      screenshotName: `cf-unsolved-${safe(account.email)}`,
    });
  }

  if (await turnstileFailed(page)) {
    log.warn('Cloudflare marcou "Falha na verificacao" antes do submit.');
    return retryAfterTurnstileFailure(page, account, {
      proxy,
      log,
      sel,
      captchaRefreshAttempt,
      reason: 'turnstile reprovado pelo cloudflare (tentar IP novo)',
      screenshotName: `cf-fail-${safe(account.email)}`,
    });
  }

  log.info('Submetendo login (Entrar) — fallback.');
  await clickLoginEnter(page, sel, log, { cookieTimeout: 400 });
  await dismissCookieBanner(page, { timeout: 300 }).catch(() => {});
  await dismissChromeOverlays(page);

  if (
    await pollLoginAfterSubmit(page, {
      log,
      proxy,
      clickSubmit: () => clickLoginEnterFast(page, sel, log),
      accountEmail: account.email,
      emailSelector: sel.emailInput,
    })
  ) {
    return await finishWithTrialCheck(page, log, true, 'login ok');
  }

  for (let round = 0; round < 2; round++) {
    if (await turnstileFailed(page)) {
      log.warn('Cloudflare marcou "Falha na verificacao" -> IP de proxy provavelmente ruim.');
      await screenshot(page, `cf-fail-${safe(account.email)}`, log);
      return finish(page, false, 'turnstile reprovado pelo cloudflare (tentar IP novo)');
    }

    const solved = await maybeSolveTurnstile(page, { proxy, log }, `pos-submit #${round + 1}`, {
      waitMs: isProxyActive() ? 800 : 2000,
    });
    if (solved.solved) {
      await dismissCookieBanner(page, { timeout: 300 });
      await clickLoginEnterFast(page, sel, log);
    }

    if (
      await pollLoginAfterSubmit(page, {
        log,
        proxy,
        clickSubmit: () => clickLoginEnterFast(page, sel, log),
        maxMs: 25000,
        accountEmail: account.email,
        emailSelector: sel.emailInput,
      })
    ) {
      return await finishWithTrialCheck(page, log, true, 'login ok');
    }

    const err = await readVisibleError(page);
    if (err && !(await turnstileFailed(page))) {
      await screenshot(page, `login-fail-${safe(account.email)}`, log);
      return finish(page, false, err, { invalidCredentials: isInvalidLoginCredentials(err) });
    }
  }

  if (await isLoggedInSafe(page)) return await finishWithTrialCheck(page, log, true, 'login ok');

  if (await isEmailProviderScreen(page)) {
    log.warn('Login parou na tela de provedores — tentativa final de recuperacao.');
    const recovered = await recoverEmailLoginFormIfNeeded(page, sel.emailInput, {
      log,
      accountEmail: account.email,
      formTimeout,
    });
    if (recovered) {
      return finish(page, false, 'login voltou para provedores (recuperacao incompleta — retry)');
    }
  }

  const err = await readVisibleError(page);
  await screenshot(page, `login-fail-${safe(account.email)}`, log);
  const reason = err || 'login travado na tela de sign-in (proxy lenta ou cookies bloqueando)';
  return finish(page, false, reason, { invalidCredentials: isInvalidLoginCredentials(reason) });
}

async function maybeSolveTurnstile(page, ctx, when, { waitMs = 1500 } = {}) {
  if (await hasTurnstileToken(page)) {
    ctx.log.debug(`Turnstile ja ok (${when}).`);
    return { solved: true, skipped: false, failed: false };
  }
  if (await turnstileLooksSolved(page)) {
    await waitForTurnstileSolved(page, { timeout: isProxyActive() ? 350 : 500 }).catch(() => null);
    ctx.log.debug(`Turnstile ja ok (${when}).`);
    return { solved: true, skipped: false, failed: false };
  }
  const r = await solveTurnstileIfPresent(page, { ...ctx, waitMs });
  if (r.skipped) {
    ctx.log.debug(`Sem Turnstile (${when}).`);
    return { solved: false, skipped: true, failed: false };
  }
  if (r.solved) {
    ctx.log.info(`Turnstile resolvido (${when}).`);
    await sleep(isProxyActive() ? 30 : 60);
    return { solved: true, skipped: false, failed: false };
  }
  ctx.log.warn(`Turnstile nao resolvido (${when}).`);
  return { solved: false, skipped: false, failed: true };
}

async function findLoginEnterButton(page) {
  const handle = await page.evaluateHandle(() => {
    /* eslint-disable no-undef */
    const isVisible = (el) => {
      if (!el || el.disabled) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const ranked = [];
    for (const btn of document.querySelectorAll('button, [role="button"], input[type="submit"]')) {
      if (!isVisible(btn)) continue;
      const t = (btn.innerText || btn.textContent || btn.value || '').trim().toLowerCase();
      if (!t || t.includes('voltar') || t.includes('back')) continue;
      if (t.includes('próximo') || t.includes('proximo') || t.includes('next')) continue;
      if (t === 'entrar' || t === 'sign in' || t === 'log in') ranked.push({ btn, score: 100 });
      else if (btn.type === 'submit' && document.querySelector('input[type="password"]')) {
        ranked.push({ btn, score: 80 });
      }
    }

    ranked.sort((a, b) => b.score - a.score);
    return ranked[0]?.btn || null;
    /* eslint-enable no-undef */
  });
  return handle.asElement();
}

/** Clica Entrar sem esperar cookie banner (pos-captcha). */
async function clickLoginEnterFast(page, sel, log) {
  await page.bringToFront().catch(() => {});

  const btn = await findLoginEnterButton(page);
  if (btn) {
    await clickElementReliable(page, btn);
    return true;
  }

  try {
    await clickAny(page, sel.passwordSubmit, { timeout: 1500 });
    return true;
  } catch {
    /* tenta outras estrategias */
  }

  if (await clickByText(page, ['entrar', 'sign in', 'log in'], { timeout: 1200, poll: 30 })) {
    return true;
  }

  log.debug('Botao Entrar nao encontrado, tentando Enter no campo de senha.');
  try {
    await page.focus(sel.passwordInput);
  } catch {
    /* noop */
  }
  await page.keyboard.press('Enter');
  return true;
}

/** Poll rapido: assim que Turnstile = Sucesso, clica Entrar. */
async function submitLoginWhenTurnstileReady(page, sel, log, { proxy, maxWaitMs, account } = {}) {
  maxWaitMs = maxWaitMs ?? (isProxyActive() ? 22000 : 18000);
  const start = Date.now();
  let enterClicks = 0;
  const maxClicks = 4;

  while (Date.now() - start < maxWaitMs) {
    if (await turnstileFailed(page)) return false;

    const turnstileOk = (await hasTurnstileToken(page)) || (await turnstileLooksSolved(page));
    const captchaPresent =
      (await hasTurnstile(page).catch(() => false)) || hasTurnstileFrame(page);

    if (turnstileOk || !captchaPresent) {
      if (enterClicks < maxClicks) {
        if (enterClicks === 0) log.info('Turnstile ok — clicando Entrar.');
        await clickLoginEnterFast(page, sel, log);
        enterClicks += 1;
      }

      const remaining = maxWaitMs - (Date.now() - start);
      if (
        await pollLoginAfterSubmit(page, {
          log,
          proxy,
          clickSubmit: () => clickLoginEnterFast(page, sel, log),
          maxMs: Math.min(isProxyActive() ? 5000 : 3500, remaining),
          accountEmail: account?.email,
          emailSelector: sel.emailInput,
        })
      ) {
        return true;
      }

      if (await isLoggedInSafe(page)) return true;
    } else if (enterClicks === 0 && Date.now() - start > 800) {
      await maybeSolveTurnstile(page, { proxy, log }, 'aguardando captcha', { waitMs: 250 });
    }

    await sleep(35);
  }

  return false;
}

/** Clica Proximo/Continuar na etapa de email (2 passos) — sem esperar Turnstile antes. */
async function clickEmailNext(page, sel, log, account) {
  await dismissCookieBanner(page, { timeout: 1500 }).catch(() => {});
  const clicked = await clickByText(
    page,
    ['próximo', 'proximo', 'next', 'continuar', 'continue', 'avançar', 'avancar'],
    { timeout: 2000, poll: 80 },
  );
  if (clicked) {
    await sleep(isProxyActive() ? 200 : 350);
    await recoverEmailLoginFormIfNeeded(page, sel.emailInput, {
      log,
      accountEmail: account?.email,
      formTimeout: 8000,
    });
    return;
  }
  await clickSubmit(page, sel.emailSubmit, log, { skipCookies: true });
  await sleep(isProxyActive() ? 200 : 350);
  await recoverEmailLoginFormIfNeeded(page, sel.emailInput, {
    log,
    accountEmail: account?.email,
    formTimeout: 8000,
  });
}

async function clickSubmit(page, selector, log, { skipCookies = false } = {}) {
  if (!skipCookies) {
    await dismissCookieBanner(page, { timeout: 1200 }).catch(() => {});
  }
  try {
    await clickAny(page, selector, { timeout: 4000 });
    return;
  } catch {
    /* tenta outras estrategias */
  }
  const byText = await clickByText(
    page,
    ['continuar', 'avançar', 'avancar', 'próximo', 'proximo', 'entrar', 'continue', 'next', 'sign in', 'log in'],
    { timeout: 2500 },
  );
  if (byText) return;
  log.debug('Botao submit nao encontrado, tentando Enter.');
  await page.keyboard.press('Enter');
}

/** Clica no botao Entrar (evita Voltar/Proximo e prioriza submit da senha). */
async function clickLoginEnter(page, sel, log, { cookieTimeout = 1200 } = {}) {
  await wakePage(page);
  await dismissCookieBanner(page, { timeout: cookieTimeout }).catch(() => {});

  const clicked = await page
    .evaluate(() => {
      /* eslint-disable no-undef */
      const isVisible = (el) => {
        if (!el || el.disabled) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      };

      const ranked = [];
      for (const btn of document.querySelectorAll('button, [role="button"], input[type="submit"]')) {
        if (!isVisible(btn)) continue;
        const t = (btn.innerText || btn.textContent || btn.value || '').trim().toLowerCase();
        if (!t || t.includes('voltar') || t.includes('back')) continue;
        if (t.includes('próximo') || t.includes('proximo') || t.includes('next')) continue;
        if (t === 'entrar' || t === 'sign in' || t === 'log in') ranked.push({ btn, score: 100 });
        else if (btn.type === 'submit' && document.querySelector('input[type="password"]')) {
          ranked.push({ btn, score: 80 });
        }
      }

      ranked.sort((a, b) => b.score - a.score);
      if (ranked[0]) {
        ranked[0].btn.click();
        return true;
      }
      return false;
      /* eslint-enable no-undef */
    })
    .catch(() => false);

  if (clicked) return;

  try {
    await clickAny(page, sel.passwordSubmit, { timeout: 3000 });
    return;
  } catch {
    /* tenta outras estrategias */
  }

  const byText = await clickByText(page, ['entrar', 'sign in', 'log in'], { timeout: 2000, poll: 80 });
  if (byText) return;

  log.debug('Botao Entrar nao encontrado, tentando Enter no campo de senha.');
  try {
    await page.focus(sel.passwordInput);
  } catch {
    /* noop */
  }
  await page.keyboard.press('Enter');
}

/** Botao Entrar com spinner / disabled apos submit. */
async function isLoginSubmitPending(page) {
  try {
    return await page.evaluate(() => {
      /* eslint-disable no-undef */
      if (!/accounts\.x\.ai/i.test(location.href)) return false;
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const t = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        if (!t && !btn.querySelector('svg')) continue;
        const isSubmit =
          btn.type === 'submit' ||
          t.includes('entrar') ||
          t.includes('sign in') ||
          t.includes('continuar') ||
          t.includes('continue');
        if (!isSubmit && !btn.querySelector('svg[class*="spin" i], [class*="loading" i], [class*="loader" i]')) {
          continue;
        }
        if (
          btn.disabled ||
          btn.getAttribute('aria-busy') === 'true' ||
          btn.querySelector('svg[class*="spin" i], [class*="loading" i], [class*="loader" i], [class*="animate" i]')
        ) {
          return true;
        }
      }
      return false;
      /* eslint-enable no-undef */
    });
  } catch (err) {
    if (isNavigationError(err)) return false;
    return false;
  }
}

async function isLoggedInSafe(page) {
  try {
    return await isLoggedIn(page);
  } catch (err) {
    if (!isNavigationError(err)) return false;
    await sleep(600);
    try {
      return await isLoggedIn(page);
    } catch {
      return false;
    }
  }
}

async function waitForLoginComplete(page, { timeout = 800, poll } = {}) {
  poll = poll ?? effectiveLoginPollMs();
  try {
    return await waitForLoggedIn(page, { timeout, poll });
  } catch (err) {
    if (!isNavigationError(err)) throw err;
    await sleep(isProxyActive() ? 300 : 500);
    return waitForLoggedIn(page, { timeout: Math.max(timeout, 5000), poll: Math.max(poll, 150) });
  }
}

/**
 * Aguarda redirect pos-submit. Com proxy: sem reenvio precoce (só loading >45s).
 */
async function pollLoginAfterSubmit(page, { log, proxy, clickSubmit, maxMs, accountEmail, emailSelector } = {}) {
  const proxyOn = !!(proxy?.host);
  maxMs = maxMs ?? effectiveLoginPostSubmitMs();
  const start = Date.now();
  let loadingResubmits = 0;
  let stuckResubmits = 0;
  let loadingSince = null;
  let stuckSince = null;
  const loadingResubmitMs = proxyOn ? 35000 : 30000;
  const stuckResubmitMs = proxyOn ? 4000 : 6000;
  const pollMs = effectiveLoginPollMs();
  const maxStuckResubmits = 4;

  while (Date.now() - start < maxMs) {
    if (await waitForLoginComplete(page, { poll: pollMs })) return true;

    try {
      const connErr = await readConnectionError(page);
      if (connErr) {
        throw new Error(connErr);
      }

      await dismissCookieBanner(page, { timeout: 400 }).catch(() => {});

      const onSignIn = /accounts\.x\.ai/i.test(safePageUrl(page, ''));
      if (onSignIn && emailSelector && (await isEmailProviderScreen(page))) {
        log.warn('Redirect para provedores durante submit — recuperando...');
        await recoverEmailLoginFormIfNeeded(page, emailSelector, {
          log,
          accountEmail,
          formTimeout: 8000,
        });
      }

      const turnstileOk = (await hasTurnstileToken(page)) || (await turnstileLooksSolved(page));

      if (onSignIn && turnstileOk && !(await isLoginSubmitPending(page))) {
        if (!stuckSince) stuckSince = Date.now();
        else if (
          Date.now() - stuckSince > stuckResubmitMs &&
          stuckResubmits < maxStuckResubmits
        ) {
          log.info('Turnstile ok mas login parado — clicando Entrar de novo...');
          await clickSubmit();
          stuckResubmits++;
          stuckSince = Date.now();
        }
      } else if (!onSignIn) {
        stuckSince = null;
      }

      const pending = await isLoginSubmitPending(page);
      if (pending) {
        if (!loadingSince) loadingSince = Date.now();
        else if (
          Date.now() - loadingSince > loadingResubmitMs &&
          loadingResubmits < 1 &&
          turnstileOk
        ) {
          log.warn(`Loading prolongado (>${Math.round(loadingResubmitMs / 1000)}s) — reenviando submit...`);
          await clickSubmit();
          loadingResubmits++;
          loadingSince = Date.now();
        }
      } else {
        loadingSince = null;
      }
    } catch (err) {
      if (isConnectionError(err.message)) throw err;
      if (isNavigationError(err)) {
        log.debug('Redirect durante login — verificando sessao...');
        if (await waitForLoginComplete(page, { timeout: 8000, poll: pollMs })) return true;
        await sleep(isProxyActive() ? 200 : 400);
        continue;
      }
      throw err;
    }

    await sleep(pollMs);
  }

  return waitForLoginComplete(page, { timeout: 6000, poll: Math.max(pollMs, 150) });
}

async function isLoggedIn(page) {
  const url = safePageUrl(page, '');
  if (!isLoggedInUrl(url)) return false;

  const stillHasAuthFields = await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    return !!document.querySelector('input[type="password"]');
  }).catch((err) => {
    if (isNavigationError(err)) return false;
    return true;
  });
  return !stillHasAuthFields;
}

async function readConnectionError(page) {
  try {
    return await page.evaluate(() => {
      /* eslint-disable no-undef */
      const body = document.body?.innerText || '';
      const patterns = [
        /erro de conex[aã]o[^\n.]*/i,
        /connection (failed|error|refused|reset)[^\n.]*/i,
        /n[aã]o foi poss[ií]vel conectar[^\n.]*/i,
        /this site can.?t be reached[^\n.]*/i,
        /no internet[^\n.]*/i,
        /err_tunnel_connection_failed/i,
        /err_connection_[a-z_]+/i,
      ];
      for (const re of patterns) {
        const m = body.match(re);
        if (m) return m[0].trim().slice(0, 160);
      }
      return null;
      /* eslint-enable no-undef */
    });
  } catch {
    return null;
  }
}

async function turnstileFailed(page) {
  try {
    return await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      const txt = (document.body.innerText || '').toLowerCase();
      return (
        txt.includes('falha na verificação') ||
        txt.includes('falha na verificacao') ||
        txt.includes('verification failed') ||
        txt.includes('error occurred') ||
        txt.includes('ocorreu um erro')
      );
    });
  } catch {
    return false;
  }
}

async function readVisibleError(page) {
  try {
    return await page.evaluate(() => {
      /* eslint-disable no-undef */
      const AUTH_ERROR_RES = [
        /e-?mail ou senha incorret[^\n.]*/i,
        /senha incorret[^\n.]*/i,
        /credenciais inv[aá]lidas[^\n.]*/i,
        /incorrect (e-?mail|password|credentials)[^\n.]*/i,
        /invalid (e-?mail|password|credentials)[^\n.]*/i,
        /wrong (e-?mail|password)[^\n.]*/i,
        /authentication failed[^\n.]*/i,
        /could(n'?t| not) sign[^\n.]*/i,
        /unable to sign[^\n.]*/i,
        /user not found[^\n.]*/i,
        /conta n[aã]o existe[^\n.]*/i,
      ];

      const body = document.body?.innerText || '';
      for (const re of AUTH_ERROR_RES) {
        const m = body.match(re);
        if (m) return m[0].trim().slice(0, 200);
      }

      const isFieldLabel = (t) => /^(e-?mail|senha|password|email)$/i.test(t.trim());
      const looksLikeAuthError = (t) =>
        /incorret|inv[aá]lid|wrong|failed|n[aã]o encontrad|does not exist|not authorized/i.test(t);

      const nodes = document.querySelectorAll(
        '[role="alert"], .error, [class*="error" i], [data-error], p, span, div',
      );
      for (const n of nodes) {
        const style = window.getComputedStyle(n);
        if (style.display === 'none' || style.visibility === 'hidden' || !n.offsetParent) continue;
        const t = (n.textContent || '').trim();
        if (!t || t.length < 10 || isFieldLabel(t)) continue;
        if (looksLikeAuthError(t)) return t.slice(0, 200);
      }

      return null;
      /* eslint-enable no-undef */
    });
  } catch {
    return null;
  }
}

function finish(page, ok, reason, extra = {}) {
  return { ok, reason, url: safePageUrl(page, config.postLoginUrl), ...extra };
}

async function finishWithTrialCheck(page, log, ok, reason) {
  try {
    const url = safePageUrl(page, '');
    const onGrok =
      url.includes('grok.com') && !/sign-?in|login|accounts\.x\.ai|\/auth/i.test(url);
    if (config.postLoginUrl && !onGrok && !url.includes(config.loggedInUrlHint)) {
      await gotoWithRetry(page, config.postLoginUrl, {
        log,
        retries: 1,
        timeout: isProxyActive() ? 20000 : 15000,
      }).catch(() => {});
    }

    await wakePage(page);

    // Com SUBSCRIBE_TRIAL, quem decide o trial e o fluxo de assinatura (abre
    // #subscribe direto). Checar aqui na home so atrasa o clique no CTA.
    if (config.subscribeTrial) {
      return finish(page, ok, reason, { trialDetected: null });
    }

    const trialDetected = await isTrialOfferAvailable(page, { log, quickCheck: true });
    if (trialDetected) {
      log.info('Trial detectado na pagina ($0.00 / grátis).');
      return finish(page, ok, `${reason} + trial`, { trialDetected: true });
    }

    log.warn('Trial NAO detectado (conta ja usada ou proxy/IP com baixa confianca).');
    return finish(page, ok, `${reason} (sem trial)`, { trialDetected: false });
  } catch (err) {
    if (isNavigationError(err) && (await isLoggedInSafe(page))) {
      log.info('Login confirmado apos redirect.');
      return finish(page, ok, reason, { trialDetected: null });
    }
    throw err;
  }
}

function safe(s) {
  return String(s || '').replace(/[^a-z0-9]/gi, '_').slice(0, 40);
}

async function retryAfterTurnstileFailure(
  page,
  account,
  { proxy, log, sel, captchaRefreshAttempt = 0, reason, screenshotName },
) {
  if (captchaRefreshAttempt < 1) {
    log.warn('Turnstile falhou na pagina atual — recarregando login e tentando de novo...');
    await gotoWithRetry(page, config.emailLoginUrl, { log, retries: 1, timeout: 20000 });
    await wakePage(page);
    return loginGrokInner(page, account, {
      proxy,
      log,
      sel,
      captchaRefreshAttempt: captchaRefreshAttempt + 1,
    });
  }

  await screenshot(page, screenshotName, log);
  return finish(page, false, reason);
}
