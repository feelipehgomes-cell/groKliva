import { config } from '../config.js';
import { effectiveNavTimeout, isProxyActive } from '../proxy/proxy.js';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Erro comum quando a pagina navega no meio de um evaluate/click (login com proxy). */
export function isNavigationError(err) {
  const msg = err?.message || String(err);
  // acquireContextId/createIsolatedWorld: rebrowser-patches perde o frame apos
  // navegacao/troca de contexto — transiente, NUNCA deve derrubar o fluxo.
  return /execution context was destroyed|context was destroyed|detached Frame|frame was detached|Target closed|Cannot find context|Protocol error.*Target closed|acquireContextId failed|createIsolatedWorld|No frame with given id/i.test(
    msg,
  );
}

export function safePageUrl(page, fallback = '') {
  try {
    return page.url();
  } catch (err) {
    if (isNavigationError(err)) return fallback;
    throw err;
  }
}

/**
 * Fecha popups nativos do Chrome (ex.: "Salvar senha?") via Escape.
 * O popup nao faz parte do DOM da pagina — so teclas ajudam.
 */
export async function dismissChromeOverlays(page) {
  try {
    const keyboard = page.keyboard;
    if (!keyboard) return;
    await keyboard.press('Escape');
    await sleep(200);
    await keyboard.press('Escape');
  } catch {
    /* noop */
  }
}

/** Fecha popups comuns (Google Translate, prompts) que bloqueiam cliques. */
export async function dismissPageOverlays(page, { subscribeSafe = false } = {}) {
  // Na tela #subscribe, Escape fecha o modal de planos e volta pra home.
  if (!subscribeSafe) {
    await dismissChromeOverlays(page);
  }
  await page
    .evaluate(() => {
      /* eslint-disable no-undef */
      for (const sel of [
        '.goog-te-banner-frame',
        'iframe.goog-te-banner-frame',
        '[class*="translate" i][role="dialog"]',
      ]) {
        document.querySelectorAll(sel).forEach((el) => el.remove?.());
      }
      if (!subscribeSafe) {
        for (const el of document.querySelectorAll('button, a, [role="button"]')) {
          const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
            .trim()
            .toLowerCase();
          if (
            t === '×' ||
            t === 'x' ||
            t.includes('não traduzir') ||
            t.includes('nao traduzir') ||
            t.includes('never translate')
          ) {
            el.click();
          }
        }
      }
      /* eslint-enable no-undef */
    })
    .catch(() => {});

  const dismissTexts = subscribeSafe
    ? ['não traduzir', 'nao traduzir', 'never translate']
    : ['não traduzir', 'nao traduzir', 'never translate', 'fechar', 'close'];

  await clickByText(page, dismissTexts, {
    timeout: subscribeSafe ? 400 : 600,
    poll: 100,
  }).catch(() => false);
}

/**
 * Navega para uma URL com retry. Tolera ERR_TIMED_OUT, frame detached e
 * redirects no meio da navegacao (comuns em paginas de auth atras de proxy).
 *
 * @returns {Promise<boolean>} true se navegou com sucesso.
 */
export async function gotoWithRetry(page, url, { retries = 3, timeout, log } = {}) {
  const navTimeout = timeout ?? effectiveNavTimeout();
  const transient = /ERR_TIMED_OUT|frame was detached|ERR_CONNECTION|ERR_PROXY|ERR_TUNNEL|ERR_EMPTY_RESPONSE|Navigation timeout|ERR_NETWORK_CHANGED|ERR_ABORTED/i;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      return true;
    } catch (err) {
      const msg = err.message || '';
      // as vezes o goto "falha" mas a pagina de fato carregou (redirect) -> valida pela URL
      let landed = false;
      try {
        landed = page.url().includes(new URL(url).hostname);
      } catch {
        /* noop */
      }
      if (landed) {
        log?.debug?.(`goto "falhou" mas pagina carregou (${msg.slice(0, 60)}).`);
        return true;
      }
      if (!transient.test(msg) || attempt === retries) {
        if (attempt === retries) log?.warn?.(`goto falhou apos ${retries} tentativas: ${msg}`);
        throw err;
      }
      log?.debug?.(`goto tentativa ${attempt}/${retries} falhou (${msg.slice(0, 60)}), repetindo...`);
      await sleep((isProxyActive() ? 700 : 1500) * attempt);
    }
  }
  return false;
}

/**
 * Espera qualquer um de uma lista de selectors (separados por virgula tambem funcionam).
 * Retorna o ElementHandle do primeiro que aparecer, ou null no timeout.
 */
export async function waitForAnySelector(page, selector, { timeout = config.defaultTimeout } = {}) {
  try {
    await page.waitForSelector(selector, { timeout, visible: true });
    return await page.$(selector);
  } catch {
    return null;
  }
}

/**
 * Preenche um input com digitacao humana (eventos isTrusted=true).
 * Digita em blocos curtos e re-foca o campo a cada bloco para sobreviver
 * ao resolvedor de Turnstile do puppeteer-real-browser (cliques em background).
 * Fallback atomico so se a digitacao humana falhar (login ok, mas trial pode nao aparecer).
 */
export async function typeInto(page, selector, text, { verify = true, selectorTimeout = 8000 } = {}) {
  const value = String(text ?? '');
  let length = await typeIntoHuman(page, selector, value, selectorTimeout);

  if (verify && length !== value.length) {
    await sleep(120);
    length = await typeIntoHuman(page, selector, value, selectorTimeout);
  }

  if (verify && length !== value.length) {
    const atomic = await fillInputAtomic(page, selector, value);
    if (!atomic.found) throw new Error(`Campo nao encontrado: ${selector}`);
    if (atomic.length !== value.length) {
      throw new Error(
        `Campo incompleto (${selector}): preencheu ${atomic.length}/${value.length} caracteres`,
      );
    }
  }

  return { length: value.length };
}

async function typeIntoHuman(page, selector, value, selectorTimeout = 8000) {
  const el = await waitForAnySelector(page, selector, { timeout: selectorTimeout });
  if (!el) return 0;

  await el.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await sleep(40);

  const chunkSize = 4;
  for (let i = 0; i < value.length; i += chunkSize) {
    if (i % (chunkSize * 2) === 0) {
      try {
        const handle = (await page.$(selector)) || el;
        await handle.click({ clickCount: 1 });
      } catch {
        /* noop */
      }
    }
    const chunk = value.slice(i, i + chunkSize);
    await page.keyboard.type(chunk, { delay: 18 + Math.random() * 22 });
    await sleep(25 + Math.random() * 25);
  }

  return getInputLength(page, selector);
}

async function getInputLength(page, selector) {
  return page.evaluate(
    (sel) => {
      /* eslint-disable no-undef */
      const selectors = sel.split(',').map((s) => s.trim()).filter(Boolean);
      for (const s of selectors) {
        const candidates = Array.from(document.querySelectorAll(s));
        const el = candidates.find((node) => {
          const style = window.getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && node.offsetParent !== null;
        });
        if (el) return el.value.length;
      }
      return 0;
      /* eslint-enable no-undef */
    },
    selector,
  );
}

async function fillInputAtomic(page, selector, value) {
  return page.evaluate(
    (sel, text) => {
      /* eslint-disable no-undef */
      const selectors = sel.split(',').map((s) => s.trim()).filter(Boolean);
      let el = null;
      for (const s of selectors) {
        const candidates = Array.from(document.querySelectorAll(s));
        el = candidates.find((node) => {
          const style = window.getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && node.offsetParent !== null;
        });
        if (el) break;
      }
      if (!el) return { found: false, length: 0 };

      el.focus();
      el.click();

      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      const setValue = (v) => {
        if (setter) setter.call(el, v);
        else el.value = v;
      };

      setValue('');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));

      setValue(text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      return { found: true, length: el.value.length };
      /* eslint-enable no-undef */
    },
    selector,
    value,
  );
}

async function getInputValue(page, selector) {
  return page.evaluate(
    (sel) => {
      /* eslint-disable no-undef */
      const selectors = sel.split(',').map((s) => s.trim()).filter(Boolean);
      for (const s of selectors) {
        const candidates = Array.from(document.querySelectorAll(s));
        const el = candidates.find((node) => {
          const style = window.getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && node.offsetParent !== null;
        });
        if (el) return el.value;
      }
      return '';
      /* eslint-enable no-undef */
    },
    selector,
  );
}

/** Preenche input de uma vez (sem digitacao humana) — evita perder chars com Turnstile em background. */
export async function setInputValue(page, selector, value, { selectorTimeout = 8000 } = {}) {
  await wakePage(page);
  const el = await waitForAnySelector(page, selector, { timeout: selectorTimeout });
  if (!el) throw new Error(`Campo nao encontrado: ${selector}`);

  const text = String(value ?? '');
  const result = await fillInputAtomic(page, selector, text);
  if (!result.found) throw new Error(`Campo nao encontrado: ${selector}`);
  if (result.length !== text.length) {
    throw new Error(`Campo incompleto (${selector}): preencheu ${result.length}/${text.length} caracteres`);
  }
  return result;
}

/** Confirma valor do input; re-preenche se Turnstile roubar foco durante o fill. */
export async function assertInputValue(page, selector, expected, { log, attempts = 2 } = {}) {
  const want = String(expected ?? '');
  for (let i = 0; i < attempts; i++) {
    const actual = await getInputValue(page, selector);
    if (actual === want) return true;
    log?.debug?.(`Valor divergente ("${actual}" != "${want}") — re-preenchendo (${i + 1}/${attempts}).`);
    await setInputValue(page, selector, want, { selectorTimeout: 5000 });
    await sleep(80);
  }
  const finalVal = await getInputValue(page, selector);
  if (finalVal !== want) {
    log?.warn?.(`Campo incompleto: "${finalVal}" (esperado "${want}").`);
    return false;
  }
  return true;
}

/**
 * Clica no primeiro selector visivel que existir.
 */
export async function clickAny(page, selector, { timeout = config.defaultTimeout } = {}) {
  const el = await waitForAnySelector(page, selector, { timeout });
  if (!el) throw new Error(`Botao nao encontrado: ${selector}`);
  await el.click();
  return el;
}

/**
 * Instala auto-dismiss do banner de cookies (OneTrust) na propria pagina:
 * clica "Aceitar todos os cookies" no instante em que o banner renderizar.
 * Idempotente (flag na window); sobrevive ate a proxima navegacao real.
 */
export async function installCookieAutoDismiss(page) {
  await page
    .evaluate(() => {
      /* eslint-disable no-undef */
      if (window.__grokpixCookieAutoDismiss) return;
      window.__grokpixCookieAutoDismiss = true;

      const clickAccept = () => {
        const btn = document.querySelector(
          '#onetrust-accept-btn-handler, [data-testid="cookie-accept-all"], #CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      };

      if (clickAccept()) return;
      const obs = new MutationObserver(() => {
        if (clickAccept()) obs.disconnect();
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      // Nao observar para sempre (o banner so aparece uma vez por sessao).
      setTimeout(() => obs.disconnect(), 180000);
      /* eslint-enable no-undef */
    })
    .catch(() => {});
}

/**
 * Remove blockers leves na tela #subscribe (cookies/tradutor).
 * Rapido: so espera timeouts longos se o banner estiver visivel.
 */
export async function dismissSubscribeClickBlockers(page) {
  const state = await page
    .evaluate(() => {
      /* eslint-disable no-undef */
      for (const sel of [
        '.goog-te-banner-frame',
        'iframe.goog-te-banner-frame',
        '[class*="translate" i][role="dialog"]',
        '#gtx-trans',
        '.goog-te-gadget',
      ]) {
        document.querySelectorAll(sel).forEach((el) => el.remove?.());
      }
      // OneTrust permanece no DOM depois de fechado (so fica invisivel) —
      // checar VISIBILIDADE, senao cada dismiss gasta o timeout cheio a toa.
      const isShown = (el) => {
        if (!el) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 8 && r.height > 8;
      };
      // innerText ja exclui texto de elementos ocultos.
      const body = document.body?.innerText || '';
      const cookieVisible =
        /aceitar todos os cookies|aceitar todos|accept all cookies|accept all|rejeitar todos|reject all|defini[cç][oõ]es de cookies|cookie consent|usamos cookies|we use cookies|este site usa cookies/i.test(
          body,
        ) ||
        ['#onetrust-banner-sdk', '#onetrust-pc-sdk', '#CybotCookiebotDialog', '#onetrust-accept-btn-handler', '[data-testid="cookie-accept-all"]']
          .some((sel) => isShown(document.querySelector(sel)));
      const translateVisible = /n[aã]o traduzir|never translate/i.test(body);
      return { cookieVisible, translateVisible };
      /* eslint-enable no-undef */
    })
    .catch(() => ({ cookieVisible: false, translateVisible: false }));

  if (state.cookieVisible) {
    await dismissCookieBanner(page, { timeout: 2000 }).catch(() => {});
  }
  if (state.translateVisible) {
    await clickByText(page, ['não traduzir', 'nao traduzir', 'never translate', 'ignorar'], {
      timeout: 600,
      poll: 80,
    }).catch(() => false);
  }
}

/** Clica por texto visivel com mouse real (React/SPA). */
export async function clickByTextReliable(page, texts, { timeout = 8000, poll = 100 } = {}) {
  const wanted = (Array.isArray(texts) ? texts : [texts]).map((t) => t.toLowerCase());
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const handle = await page.evaluateHandle((wantedTexts) => {
      /* eslint-disable no-undef */
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || !el.offsetParent) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 8 && r.height >= 8;
      };
      const els = Array.from(
        document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]'),
      );
      for (const want of wantedTexts) {
        for (const el of els) {
          if (!isVisible(el)) continue;
          const label = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
          if (!label || !label.includes(want)) continue;
          return el;
        }
      }
      return null;
      /* eslint-enable no-undef */
    }, wanted);

    const el = handle.asElement();
    if (el) {
      await clickElementReliable(page, el);
      return true;
    }
    await sleep(poll);
  }
  return false;
}

/**
 * Clica no primeiro elemento clicavel (button/a/[role=button]) cujo texto visivel
 * contenha um dos termos (case-insensitive). Util em telas com botoes por texto.
 *
 * @returns {Promise<boolean>} true se clicou.
 */
export async function clickByText(page, texts, { timeout = 8000, poll = 100 } = {}) {
  const wanted = (Array.isArray(texts) ? texts : [texts]).map((t) => t.toLowerCase());
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const clicked = await page.evaluate((wantedTexts) => {
      /* eslint-disable no-undef */
      const els = Array.from(
        document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]')
      );
      for (const el of els) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || el.offsetParent === null) continue;
        const label = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
        if (!label) continue;
        if (wantedTexts.some((w) => label.includes(w))) {
          el.click();
          return true;
        }
      }
      return false;
      /* eslint-enable no-undef */
    }, wanted);

    if (clicked) return true;
    await sleep(poll);
  }
  return false;
}

const EMAIL_LOGIN_TEXTS = [
  'login com e-mail',
  'login com email',
  'sign in with email',
  'continuar com e-mail',
  'continue with email',
];

const EMAIL_LOGIN_SELECTORS = [
  'button[data-provider="email"]',
  'a[data-provider="email"]',
  '[data-testid="email-login"]',
  '[data-testid="login-with-email"]',
];

export async function isEmailInputVisible(page, selector) {
  return page
    .evaluate((sel) => {
      /* eslint-disable no-undef */
      const selectors = sel.split(',').map((s) => s.trim()).filter(Boolean);
      for (const s of selectors) {
        const candidates = Array.from(document.querySelectorAll(s));
        const el = candidates.find((node) => {
          const style = window.getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && node.offsetParent !== null;
        });
        if (el) return true;
      }
      return false;
      /* eslint-enable no-undef */
    }, selector)
    .catch(() => false);
}

/** URL com ?email=true (nao confundir com ?email=conta@... que pode mostrar provedores). */
export function isEmailLoginUrl(url = '') {
  return /[?&]email=true/i.test(String(url));
}

export function hasEmailQueryInUrl(url = '') {
  return /[?&]email=/i.test(String(url));
}

/** ?email=conta@site.com abre provedores no x.ai — nao usar para navegacao inicial. */
export function hasAccountEmailInUrl(url = '') {
  const match = String(url).match(/[?&]email=([^&]+)/i);
  if (!match) return false;
  try {
    const value = decodeURIComponent(match[1]).trim().toLowerCase();
    return value !== 'true' && value.includes('@');
  } catch {
    return match[1].includes('@');
  }
}

/** Espera o campo de email aparecer (sem recarregar a pagina). */
export async function waitForEmailLoginForm(page, emailSelector, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isEmailInputVisible(page, emailSelector)) return true;
    await sleep(80);
  }
  return isEmailInputVisible(page, emailSelector);
}

export async function isEmailProviderScreen(page) {
  return page
    .evaluate(() => {
      /* eslint-disable no-undef */
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      return buttons.some((b) => {
        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
        return (
          t.includes('login com e-mail') ||
          t.includes('login com email') ||
          t.includes('login com google') ||
          t.includes('sign in with email')
        );
      });
      /* eslint-enable no-undef */
    })
    .catch(() => false);
}

async function clickEmailLoginViaDom(page) {
  return page
    .evaluate((texts) => {
      /* eslint-disable no-undef */
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      };
      const fireClick = (el) => {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        el.focus?.();
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
          el.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, view: window }),
          );
        }
        return true;
      };
      const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      for (const want of texts) {
        for (const el of els) {
          if (!isVisible(el)) continue;
          const label = (el.innerText || el.textContent || '').trim().toLowerCase();
          if (label === want || label.includes(want)) return fireClick(el);
        }
      }
      return false;
      /* eslint-enable no-undef */
    }, EMAIL_LOGIN_TEXTS)
    .catch(() => false);
}

async function findEmailLoginButton(page) {
  const handle = await page.evaluateHandle((texts) => {
    /* eslint-disable no-undef */
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };
    const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    for (const want of texts) {
      for (const el of els) {
        if (!isVisible(el)) continue;
        const label = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (label === want) return el;
      }
    }
    for (const want of texts) {
      for (const el of els) {
        if (!isVisible(el)) continue;
        const label = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (label.includes(want)) return el;
      }
    }
    return null;
    /* eslint-enable no-undef */
  }, EMAIL_LOGIN_TEXTS);
  return handle.asElement();
}

export async function clickElementReliable(page, el) {
  await el.evaluate((node) => {
    /* eslint-disable no-undef */
    node.scrollIntoView({ block: 'center', inline: 'nearest' });
    /* eslint-enable no-undef */
  });
  await sleep(40);
  try {
    const box = await el.boundingBox();
    if (box && box.width > 2 && box.height > 2) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await sleep(30);
      await page.mouse.down();
      await sleep(50);
      await page.mouse.up();
      await sleep(100);
      return true;
    }
  } catch {
    /* fallback abaixo */
  }
  await el.click({ delay: 60 });
  await sleep(100);
  return true;
}

/** Clica "Login com e-mail" na tela de provedores (sem goto). */
export async function clickEmailProviderLogin(page, emailSelector, { log, timeout = 8000 } = {}) {
  if (await isEmailInputVisible(page, emailSelector)) return true;
  if (!(await isEmailProviderScreen(page))) return false;

  await dismissCookieBanner(page, { timeout: 4000 }).catch(() => {});
  log?.info?.('Clicando Login com e-mail na tela de provedores...');
  return openEmailLoginForm(page, emailSelector, { timeout, log, clickOnly: true });
}

/**
 * Reabre o formulario de email quando a pagina volta para provedores ou URL ?email=conta@...
 * O x.ai atualiza a URL ao digitar email; reload/redirect nessa URL mostra provedores de novo.
 */
export async function recoverEmailLoginFormIfNeeded(
  page,
  emailSelector,
  { log, accountEmail, formTimeout = 10000 } = {},
) {
  await dismissCookieBanner(page, { timeout: 2500 }).catch(() => {});

  if (await isEmailInputVisible(page, emailSelector)) {
    if (accountEmail) {
      const actual = await getInputValue(page, emailSelector).catch(() => '');
      if (actual !== accountEmail) {
        log?.debug?.('Re-preenchendo email apos recuperacao.');
        await setInputValue(page, emailSelector, accountEmail, { selectorTimeout: formTimeout });
      }
    }
    return true;
  }

  const onProviders = await isEmailProviderScreen(page);
  const url = safePageUrl(page, '');
  const badUrl = hasAccountEmailInUrl(url);

  if (!onProviders && !badUrl) return false;

  log?.warn?.(
    onProviders
      ? 'Tela de provedores detectada — recuperando formulario de email...'
      : 'URL com email da conta sem formulario — recuperando...',
  );

  await dismissCookieBanner(page, { timeout: 5000 }).catch(() => {});

  if (onProviders) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await dismissCookieBanner(page, { timeout: 1500 }).catch(() => {});
      await clickEmailProviderLogin(page, emailSelector, { log, timeout: 3000 });
      if (await waitForEmailLoginForm(page, emailSelector, 2500)) break;
      await sleep(150);
    }
  }

  if (!(await isEmailInputVisible(page, emailSelector))) {
    log?.info?.(`Navegando para ${config.emailLoginUrl}`);
    await gotoWithRetry(page, config.emailLoginUrl, {
      log,
      retries: 2,
      timeout: Math.min(effectiveNavTimeout(), formTimeout),
    });
    await dismissCookieBanner(page, { timeout: 4000 }).catch(() => {});
    await openEmailLoginForm(page, emailSelector, { timeout: formTimeout, log, clickOnly: false });
  }

  if (accountEmail && (await isEmailInputVisible(page, emailSelector))) {
    await setInputValue(page, emailSelector, accountEmail, { selectorTimeout: formTimeout });
  }

  return isEmailInputVisible(page, emailSelector);
}

/** Garante formulario de email aberto: goto email=true > clique em provedores. */
export async function ensureEmailLoginFormReady(page, emailSelector, { log, formTimeout = 12000 } = {}) {
  if (await isEmailInputVisible(page, emailSelector)) return true;

  await waitForAnySelector(page, 'button, a, [role="button"]', {
    timeout: Math.min(formTimeout, 5000),
  }).catch(() => null);
  await dismissCookieBanner(page, { timeout: 5000 }).catch(() => {});

  const current = safePageUrl(page, '');
  const onCorrectLogin =
    /accounts\.x\.ai\/sign-in/i.test(current) &&
    isEmailLoginUrl(current) &&
    !hasAccountEmailInUrl(current);

  if (!onCorrectLogin) {
    if (hasAccountEmailInUrl(current)) {
      log?.warn?.('URL com email da conta — voltando para email=true.');
    } else if (!/accounts\.x\.ai/i.test(current)) {
      log?.info?.('Fora do login x.ai — carregando pagina de login.');
    }
    log?.info?.(`Navegando para ${config.emailLoginUrl}`);
    await gotoWithRetry(page, config.emailLoginUrl, {
      log,
      retries: isProxyActive() ? 2 : 2,
      timeout: Math.min(effectiveNavTimeout(), formTimeout),
    });
    await dismissCookieBanner(page, { timeout: 4000 }).catch(() => {});
  }

  if (await isEmailProviderScreen(page)) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await dismissCookieBanner(page, { timeout: 1500 }).catch(() => {});
      await clickEmailProviderLogin(page, emailSelector, { log, timeout: 3000 });
      if (await waitForEmailLoginForm(page, emailSelector, 2500)) return true;
      await sleep(150);
    }
  }

  if (await isEmailProviderScreen(page)) {
    await clickEmailProviderLogin(page, emailSelector, { log, timeout: Math.min(formTimeout, 8000) });
  }

  return waitForEmailLoginForm(page, emailSelector, formTimeout);
}

/** Carrega login apos proxy verify ou nova instancia (sempre email=true + clique em provedores). */
export async function prepareEmailLoginPage(page, emailSelector, { log, formTimeout = 15000 } = {}) {
  log?.info?.(`Preparando login: ${config.emailLoginUrl}`);
  return ensureEmailLoginFormReady(page, emailSelector, { log, formTimeout });
}

/** Abre o formulario de email. clickOnly=true: so clica no botao, sem goto. */
export async function openEmailLoginForm(page, emailSelector, { timeout = 10000, log, clickOnly = false } = {}) {
  if (await isEmailInputVisible(page, emailSelector)) return true;

  const current = safePageUrl(page, '');

  if (!clickOnly) {
    if (isEmailLoginUrl(current)) {
      log?.debug?.('email=true na URL — aguardando formulario.');
      const ready = await waitForEmailLoginForm(page, emailSelector, timeout);
      if (ready) return true;
    }

    if (hasEmailQueryInUrl(current) && (await isEmailProviderScreen(page))) {
      log?.warn?.('URL com email mas tela de provedores — clicando Login com e-mail.');
      clickOnly = true;
    } else if (await isEmailProviderScreen(page)) {
      clickOnly = true;
    } else if (hasEmailQueryInUrl(current)) {
      return waitForEmailLoginForm(page, emailSelector, timeout);
    }
  }

  const start = Date.now();
  let clicks = 0;

  while (Date.now() - start < timeout) {
    if (await isEmailInputVisible(page, emailSelector)) return true;

    if (clicks < 6 && (await isEmailProviderScreen(page))) {
      await dismissCookieBanner(page, { timeout: 2000 }).catch(() => {});
      let clicked = false;

      if (await clickEmailLoginViaDom(page)) {
        clicked = true;
      }

      for (const sel of EMAIL_LOGIN_SELECTORS) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          const visible = await el.evaluate((node) => {
            const style = window.getComputedStyle(node);
            return style.display !== 'none' && style.visibility !== 'hidden' && node.offsetParent !== null;
          });
          if (visible) {
            await clickElementReliable(page, el);
            clicked = true;
            break;
          }
        } catch {
          /* noop */
        }
      }

      if (!clicked) {
        const btn = await findEmailLoginButton(page);
        if (btn) {
          await clickElementReliable(page, btn);
          await sleep(80);
          await clickElementReliable(page, btn);
          clicked = true;
        }
      }

      if (clicked) {
        clicks += 1;
        log?.debug?.(`clique login e-mail #${clicks}`);
        const formWait = Date.now();
        while (Date.now() - formWait < 2500) {
          if (await isEmailInputVisible(page, emailSelector)) return true;
          await sleep(80);
        }
      } else {
        await sleep(100);
      }
      continue;
    }

    await sleep(120);
  }

  return isEmailInputVisible(page, emailSelector);
}

/** Clica "Login com e-mail" na tela de escolha de provedor (x.ai). */
export async function clickEmailLoginButton(page, { timeout = 2500, poll = 25, emailSelector } = {}) {
  const sel =
    emailSelector ||
    config.selectors?.emailInput ||
    'input[type="email"], input[name="email"], input[autocomplete="username"]';
  return openEmailLoginForm(page, sel, { timeout, log: null });
}

/**
 * Dispensa banner de cookies (OneTrust/Cookiebot e botoes por texto).
 * O modal do x.ai costuma aparecer DEPOIS do Turnstile — chamar mais de uma vez no login.
 */
async function cookieBannerVisible(page) {
  return page
    .evaluate(() => {
      /* eslint-disable no-undef */
      const body = document.body?.innerText || '';
      if (
        /aceitar todos os cookies|aceitar todos|definições de cookies|definicoes de cookies|accept all cookies|reject all cookies|rejeitar todos|cookie consent|usamos cookies|we use cookies|este site usa cookies/i.test(
          body,
        )
      ) {
        return true;
      }
      // Presenca no DOM nao basta: OneTrust fica oculto apos fechar.
      const isShown = (el) => {
        if (!el) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 8 && r.height > 8;
      };
      return ['#onetrust-banner-sdk', '#onetrust-pc-sdk', '#CybotCookiebotDialog', '#onetrust-accept-btn-handler', '[data-testid="cookie-accept-all"]']
        .some((sel) => isShown(document.querySelector(sel)));
      /* eslint-enable no-undef */
    })
    .catch(() => false);
}

async function clickCookieAcceptReliable(page) {
  const handle = await page.evaluateHandle(() => {
    /* eslint-disable no-undef */
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };
    const preferred = [
      'aceitar todos os cookies',
      'accept all cookies',
      'aceitar todos',
      'accept all',
      'rejeitar todos',
      'reject all',
    ];
    const nodes = document.querySelectorAll('button, a, [role="button"], [role="link"]');
    for (const want of preferred) {
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
          .trim()
          .toLowerCase();
        if (!label) continue;
        if (label === want || label.includes(want)) return el;
      }
    }
    return null;
    /* eslint-enable no-undef */
  });
  const el = handle.asElement();
  if (!el) return false;
  await clickElementReliable(page, el);
  return true;
}

export async function dismissCookieBanner(page, { timeout = 3500 } = {}) {
  const patterns = [
    'aceitar todos os cookies',
    'aceitar todos',
    'accept all cookies',
    'accept all',
    'rejeitar todos',
    'reject all',
    'aceitar',
    'accept',
  ];

  if (await clickCookieAcceptReliable(page)) return true;

  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeout) {
    attempts++;

    if (await clickCookieAcceptReliable(page)) return true;

    const clicked = await page
      .evaluate((wantedTexts) => {
        /* eslint-disable no-undef */
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
        };

        const known = document.querySelector(
          '#onetrust-accept-btn-handler, #CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, [data-testid="cookie-accept-all"]',
        );
        if (isVisible(known)) {
          known.click();
          return true;
        }

        const nodes = document.querySelectorAll(
          'button, a, [role="button"], [role="link"], div[role="button"], p[role="button"], span[role="button"]',
        );
        for (const el of nodes) {
          if (!isVisible(el)) continue;
          const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
            .trim()
            .toLowerCase();
          if (!label) continue;
          if (wantedTexts.some((w) => label.includes(w))) {
            el.click();
            return true;
          }
        }
        return false;
        /* eslint-enable no-undef */
      }, patterns)
      .catch((err) => {
        if (isNavigationError(err)) return 'navigated';
        return false;
      });

    if (clicked === 'navigated') return true;

    if (clicked) return true;

    if (attempts >= 2 && !(await cookieBannerVisible(page))) return false;

    await sleep(120);
  }

  return clickByText(page, patterns, { timeout: 800, poll: 100 });
}

/**
 * Fecha modais pos-login que cobrem o CTA de trial (cookies, conectar X, etc.).
 * @param {object} [opts]
 * @param {boolean} [opts.subscribeSafe] — sem Escape/fechar agressivo (antes de abrir #subscribe).
 */
export async function dismissPostLoginOverlays(page, { subscribeSafe = false } = {}) {
  await dismissCookieBanner(page);
  if (subscribeSafe) return;
  await clickByText(page, ['fechar', 'close', 'agora não', 'agora nao', 'not now'], { timeout: 1200 }).catch(
    () => false,
  );
  await dismissChromeOverlays(page);
}

export function isSubscribePlanUrl(url = '') {
  return /#subscribe|\/plans|\/upgrade/i.test(url);
}

/** Conteudo da tela #subscribe visivel (nao depende so da URL). */
export async function isSubscribeUiVisible(page) {
  return page
    .evaluate(() => {
      /* eslint-disable no-undef */
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      if (/experimente\s+\$0|try\s+\$0\.00|solicitar\s+oferta\s+de\s+\$0/i.test(body)) return true;
      if (document.querySelector('[data-testid="plan-cta-supergrok"]')) return true;
      if (/supergrok\s+lite/i.test(body) && /supergrok\s+heavy|solicitar\s+oferta|atualizar\s+para/i.test(body)) {
        return true;
      }
      return false;
      /* eslint-enable no-undef */
    })
    .catch(() => false);
}

function isGrokHomeUrl(url = '') {
  return /grok\.com/i.test(url) && !/#subscribe|\/plans|\/upgrade|checkout\.stripe/i.test(url);
}

/** Abre planos pelo menu do app (evita banner da home e reload completo). */
async function clickOpenSubscribeFromApp(page, log) {
  const clicked = await clickByTextReliable(
    page,
    ['supergrok', 'aprimorar', 'upgrade', 'melhorar', 'planos', 'plans', 'assinatura'],
    { timeout: 3500, poll: 100 },
  );
  if (clicked) {
    log?.debug?.('CTA upgrade/planos do app clicado — abrindo subscribe.');
    await sleep(isProxyActive() ? 350 : 500);
    await applySubscribeHash(page, log);
  }
  return clicked;
}

/**
 * Assim que o redirect pos-login cair em grok.com/, abre #subscribe via hash (SPA).
 * @param {boolean} [opts.force] — reaplica mesmo com #subscribe ja na URL
 *   (hash "sujo": router ignorou o hashchange antes de hidratar; reset reabre).
 */
export async function openSubscribeHashIfOnGrokHome(page, { log, force = false } = {}) {
  const url = safePageUrl(page, '');
  // Nunca mexer no hash em checkout (Stripe ou embutido) — puxaria de volta pro subscribe.
  if (!/grok\.com/i.test(url) || /checkout|stripe|\/pay\b/i.test(url)) {
    return false;
  }
  if (!force && /#subscribe|\/plans|\/upgrade/i.test(url)) return false;
  log?.debug?.(`Aplicando #subscribe via hash${force ? ' (force/reset)' : ''}.`);
  await applySubscribeHash(page, log);
  return true;
}

async function applySubscribeHash(page, log) {
  try {
    // Setar location.hash JA dispara hashchange nativo — nao despachar evento
    // sintetico em cima (evento duplicado fazia o modal abrir e fechar em seguida).
    const action = await page.evaluate(() => {
      /* eslint-disable no-undef */
      if (location.hash !== '#subscribe') {
        location.hash = 'subscribe';
        return 'set';
      }
      // Hash ja e #subscribe mas modal pode ter fechado (hash "sujo" na URL):
      // limpa e reaplica para o router reabrir — sem reload.
      const modalVisible = !!document.querySelector('[data-testid="plan-cta-supergrok"]') ||
        /solicitar\s+oferta\s+(de\s+\$0|gratuita|gr[aá]tis)|supergrok\s+lite/i.test(document.body?.innerText || '');
      if (modalVisible) return 'already-open';
      history.replaceState(null, '', location.pathname + location.search);
      location.hash = 'subscribe';
      return 'reset';
      /* eslint-enable no-undef */
    });
    await sleep(isProxyActive() ? 350 : 500);
    log?.debug?.(`Hash #subscribe aplicado (SPA, ${action}).`);
    return isSubscribePlanUrl(safePageUrl(page, ''));
  } catch (e) {
    return false;
  }
}

/** Aguarda modal/cards de planos apos navegar para #subscribe. */
export async function waitForSubscribeUiReady(page, { timeoutMs = 12000, log } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await dismissCookieBanner(page, { timeout: 2000 }).catch(() => {});
    if (await isSubscribeUiVisible(page)) return true;
    await sleep(isProxyActive() ? 180 : 250);
  }
  log?.debug?.('UI #subscribe nao apareceu no tempo esperado.');
  return false;
}

/** Navega direto para grok.com/#subscribe (pos-login ou accounts.x.ai/account). */
export async function navigateToSubscribePage(page, { log, force = false } = {}) {
  const current = safePageUrl(page, '');
  if (!force && isSubscribePlanUrl(current) && (await isSubscribeUiVisible(page))) {
    return page;
  }

  // Frame quebrado (rebrowser: acquireContextId failed) — hash/dismiss dependem
  // de evaluate e falhariam para sempre. Reload real restaura o frame.
  const frameHealthy = await page.evaluate(() => true).catch(() => false);

  await dismissCookieBanner(page, { timeout: 6000 }).catch(() => {});
  await dismissPostLoginOverlays(page, { subscribeSafe: true }).catch(() => {});

  const onGrok = frameHealthy && /grok\.com/i.test(current) && !/accounts\.x\.ai/i.test(current);
  const base = (config.postLoginUrl || 'https://grok.com').replace(/\/$/, '');


  // 1) Hash SPA — sem recarregar a home (redirect pos-login cai em grok.com/)
  // Reload completo e o ULTIMO recurso: cada goto volta pra home por segundos
  // (ping-pong subscribe→home→subscribe) e atrasa o clique no trial.
  if (onGrok) {
    log?.debug?.('grok.com detectado — abrindo #subscribe via hash (sem reload na home).');
    await applySubscribeHash(page, log);
    await dismissCookieBanner(page, { timeout: 4000 }).catch(() => {});
    if (await waitForSubscribeUiReady(page, { timeoutMs: force ? 8000 : 9000, log })) {
      return page;
    }

    // 2a tentativa de hash (reset) antes de partir para reload.
    await applySubscribeHash(page, log);
    if (await waitForSubscribeUiReady(page, { timeoutMs: 4000, log })) return page;

    if (await clickOpenSubscribeFromApp(page, log)) {
      await dismissCookieBanner(page, { timeout: 3000 }).catch(() => {});
      if (await waitForSubscribeUiReady(page, { timeoutMs: 6000, log })) return page;
    }
  }

  // 2) Rotas diretas — nunca navegar so para grok.com sem #subscribe ou /plans
  const candidates = [
    config.subscribePageUrl,
    `${base}/#subscribe`,
    `${base}/plans`,
    `${base}/upgrade`,
  ].filter((u, i, arr) => arr.indexOf(u) === i);

  for (const url of candidates) {
    if (isSubscribePlanUrl(safePageUrl(page, '')) && (await isSubscribeUiVisible(page))) {
      return page;
    }
    log?.info?.(`Indo para subscribe: ${url}`);
    await gotoWithRetry(page, url, {
      log,
      retries: isProxyActive() ? 2 : 2,
      timeout: effectiveNavTimeout(),
    }).catch((e) => {
      log?.warn?.(`Falha ao abrir ${url}: ${e.message}`);
    });

    await wakePage(page);
    await dismissCookieBanner(page, { timeout: 5000 }).catch(() => {});
    await dismissPostLoginOverlays(page, { subscribeSafe: true }).catch(() => {});

    if (!isSubscribePlanUrl(safePageUrl(page, '')) || /#subscribe/.test(url)) {
      await applySubscribeHash(page, log);
    }
    await dismissCookieBanner(page, { timeout: 4000 }).catch(() => {});

    if (await waitForSubscribeUiReady(page, { timeoutMs: 8000, log })) return page;

    if (isGrokHomeUrl(safePageUrl(page, ''))) {
      await clickOpenSubscribeFromApp(page, log);
      if (await waitForSubscribeUiReady(page, { timeoutMs: 6000, log })) return page;
    }
  }

  return page;
}

/**
 * Garante tela #subscribe aberta com UI de planos visivel.
 * @returns {Promise<{ ok: boolean, page }>}
 */
export async function ensureSubscribePageReady(page, { log, formTimeout = 15000 } = {}) {
  let attempts = 0;
  const start = Date.now();

  while (Date.now() - start < formTimeout && attempts < 5) {
    attempts += 1;
    page = await navigateToSubscribePage(page, { log, force: attempts > 1 });

    await dismissCookieBanner(page, { timeout: 4000 }).catch(() => {});

    if (await waitForSubscribeUiReady(page, { timeoutMs: Math.min(6000, formTimeout), log })) {
      log?.info?.(`Tela #subscribe pronta (${safePageUrl(page, '').slice(0, 90)})`);
      return { ok: true, page };
    }

    await sleep(300);
  }

  const ok = await isSubscribeUiVisible(page);
  if (!ok) {
    log?.warn?.(`#subscribe nao abriu (${safePageUrl(page, '').slice(0, 90)})`);
  }
  return { ok, page };
}

async function loginPageHasPassword(page) {
  try {
    return await page.evaluate(() => !!document.querySelector('input[type="password"]'));
  } catch (err) {
    if (isNavigationError(err)) return false;
    return true;
  }
}

export function isLoggedInUrl(url = '') {
  const u = String(url);
  if (/sign-?in|\/login|\/auth/i.test(u)) return false;
  if (/accounts\.x\.ai\/account/i.test(u)) return true;
  return u.includes(config.loggedInUrlHint);
}

/**
 * Poll ate a URL indicar login concluido (sem campo de senha visivel).
 * Tolera navegacao no meio do poll (proxy lenta / redirect pos-submit).
 */
export async function waitForLoggedIn(page, { timeout = effectiveNavTimeout(), poll = config.loginPollMs } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    let url = '';
    try {
      url = page.url();
    } catch (err) {
      if (isNavigationError(err)) {
        await sleep(Math.max(poll, 300));
        if (!(await loginPageHasPassword(page))) return true;
        continue;
      }
      throw err;
    }

    if (isLoggedInUrl(url) && !(await loginPageHasPassword(page))) return true;
    await sleep(poll);
  }
  return false;
}

/**
 * Espera ate que o token do Turnstile ja exista (retorno imediato se presente).
 */
export async function hasTurnstileToken(page) {
  try {
    return await page.evaluate(() => {
      /* eslint-disable no-undef */
      const inp = document.querySelector('[name="cf-turnstile-response"]');
      return !!(inp && inp.value);
      /* eslint-enable no-undef */
    });
  } catch (err) {
    if (isNavigationError(err)) return false;
    return false;
  }
}

/** UI do Turnstile mostra sucesso mesmo antes do token hidden aparecer. */
export async function turnstileLooksSolved(page) {
  if (await hasTurnstileToken(page)) return true;
  try {
    return await page.evaluate(() => {
      /* eslint-disable no-undef */
      const inp = document.querySelector('[name="cf-turnstile-response"]');
      if (inp?.value) return true;

      const successRe = /sucesso!?|success!?/i;
      const failRe = /falha na verifica|verification failed/i;

      for (const el of document.querySelectorAll(
        '.cf-turnstile, [data-sitekey], [id*="turnstile" i], iframe[src*="challenges.cloudflare.com"]',
      )) {
        let node = el;
        for (let depth = 0; depth < 4 && node; depth++) {
          const t = (node.innerText || node.textContent || '').trim();
          if (t && failRe.test(t)) return false;
          if (t && successRe.test(t)) return true;
          node = node.parentElement;
        }
      }

      const body = document.body?.innerText || '';
      if (failRe.test(body)) return false;
      return successRe.test(body) && /turnstile|cloudflare|verif/i.test(body);
      /* eslint-enable no-undef */
    });
  } catch (err) {
    if (isNavigationError(err)) return false;
    return false;
  }
}

/**
 * Retorna true se algum iframe do Cloudflare Turnstile esta carregado.
 */
export function hasTurnstileFrame(page) {
  try {
    return page.frames().some((f) => (f.url() || '').includes('challenges.cloudflare.com'));
  } catch {
    return false;
  }
}

/**
 * "Acorda" a pagina: traz pra frente e mexe o mouse (ajuda o Turnstile a renderizar).
 */

export async function wakePage(page) {
  try {
    await page.bringToFront();
  } catch {
    /* noop */
  }
  try {
    await page.mouse.move(200 + Math.random() * 400, 200 + Math.random() * 300, { steps: 5 });
  } catch {
    /* noop */
  }
}

/**
 * Passa o mouse sobre o widget do Turnstile ("nudge") para forcar interacao.
 */
export async function nudgeTurnstile(page) {
  await wakePage(page);
  try {
    const el = await page.$(config.selectors.turnstileWidget);
    if (el) {
      const box = await el.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      }
    }
  } catch {
    /* noop */
  }
}

/**
 * Espera ate que o token do Turnstile esteja preenchido (usado no modo manual).
 */
export async function waitForTurnstileSolved(page, { timeout = config.defaultTimeout } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const token = await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      const inp = document.querySelector('[name="cf-turnstile-response"]');
      return inp && inp.value ? inp.value : null;
    });
    if (token) return token;
    await sleep(config.pollMs);
  }
  return null;
}

/**
 * Retorna true se algum widget de Turnstile esta presente na pagina.
 */
export async function hasTurnstile(page) {
  return page.evaluate((sel) => {
    // eslint-disable-next-line no-undef
    return !!document.querySelector(sel);
  }, config.selectors.turnstileWidget);
}
