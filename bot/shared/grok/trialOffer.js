/** CTA trial com preco $0 (ex: "Experimente por $0.00", "Solicitar oferta de $0.00"). */
export const TRIAL_OFFER_ZERO = [
  'solicitar oferta de $0.00',
  'solicitar oferta de $0,00',
  'solicitar oferta de $0.0',
  'solicitar oferta de $0',
  'experimente por $0.00',
  'experimente por $0,00',
  'experimente por $0.0',
  'experimente por $0',
  'experimente 7 dias por $0',
  'claim $0.00 offer',
  'try for $0.00',
];

/** CTA trial gratuito sem $0 explicito (ex: "Experimente grátis", "Solicitar oferta gratuita"). */
export const TRIAL_OFFER_GRATIS = [
  'experimente grátis',
  'experimente gratis',
  'solicitar oferta gratuita',
  'solicitar oferta grátis',
  'solicitar oferta gratis',
  'claim free offer',
  'teste grátis',
  'teste gratis',
  'trial gratuito',
  'teste gratuito',
  'experimente 7 dias gratuitamente',
];

/** Textos alternativos (UI 2025/2026: "Try free", "3-day free trial"). */
export const TRIAL_OFFER_ALT = [
  'try free',
  'try for free',
  'start free trial',
  'start 3-day free trial',
  'start 3 day free trial',
  '3-day free trial',
  '3 day free trial',
  'free trial',
  'free for 3 days',
  'iniciar teste grátis',
  'iniciar teste gratis',
  'teste de 3 dias grátis',
  'teste de 3 dias gratis',
  'teste de 7 dias grátis',
  'teste de 7 dias gratis',
  'experimente 3 dias',
  'experimente 7 dias',
  'comece grátis',
  'comece gratis',
];

/** Todos os textos de trial — $0.00, grátis e variantes em EN/PT. */
export const TRIAL_OFFER_SUBSTRINGS = [
  ...TRIAL_OFFER_ZERO,
  ...TRIAL_OFFER_GRATIS,
  ...TRIAL_OFFER_ALT,
];

/** So "Aprimorar" isolado = sem trial (nao usar "upgrade" generico — falso positivo). */
export const TRIAL_UPGRADE_ONLY = ['aprimorar'];

function normalizeTrialText(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} t texto ja normalizado (lowercase) */
export function trialTextMatches(t, offerTexts = TRIAL_OFFER_SUBSTRINGS) {
  if (!t) return false;
  if (offerTexts.some((x) => t.includes(x))) return true;
  if (/experimente\s+por\s+\$0([,.]\d*)?/i.test(t)) return true;
  if (/experimente\s+\d+\s+dias?\s+por\s+\$0/i.test(t)) return true;
  if (/solicitar\s+oferta\s+(de\s+\$0|gratuita|gr[aá]tis)/i.test(t)) return true;
  if (/experimente\s+(gr[aá]tis\s+)?por\s+\d+\s+dias/i.test(t)) return true;
  if (/\d+\s+dias?\s+gratuitamente/i.test(t)) return true;
  if (t.includes('supergrok') && /\$0([,.]\d*)?/.test(t)) return true;
  if (/experimente\s+gr[aá]tis/i.test(t)) return true;
  if (/r\$\s*0([,.]\d*)?/.test(t) && /(trial|teste|gr[aá]tis|gratis|experimente|oferta)/i.test(t)) return true;
  if (/\$0([,.]\d*)?\s*(por|\/|per)\s*(m[eê]s|month|semana|week|dia|day)/i.test(t)) return true;
  if (/\d+\s*[- ]?day\s+free\s+trial/i.test(t)) return true;
  if (/\d+\s*dias?\s+(gr[aá]tis|free)/i.test(t)) return true;
  return false;
}

/**
 * Indica trial visivel no texto (home, botao, banner).
 * Aceita $0.00 OU "experimente grátis" (ou ambos na mesma pagina).
 * @param {string} raw
 */
export function textHasTrialOffer(raw) {
  return trialTextMatches(normalizeTrialText(raw), TRIAL_OFFER_SUBSTRINGS);
}

/** Botao/link so de upgrade, sem oferta trial no mesmo rotulo. */
export function elementIsUpgradeOnly(raw) {
  const t = normalizeTrialText(raw);
  if (!t || textHasTrialOffer(t)) return false;
  return TRIAL_UPGRADE_ONLY.some((x) => t === x || t.startsWith(`${x} `));
}

/**
 * Avalia a pagina: 'offer' | 'upgrade' | 'none'
 * IMPORTANTE: funcao autocontida — roda via page.evaluate (sem imports externos).
 */
export function evaluateTrialPageState(offerTexts, upgradeTexts) {
  /* eslint-disable no-undef */
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const hasOffer = (text) => {
    const t = norm(text);
    if (!t) return false;
    if (offerTexts.some((x) => t.includes(x))) return true;
    if (/experimente\s+por\s+\$0([,.]\d*)?/i.test(t)) return true;
    if (/experimente\s+\d+\s+dias?\s+por\s+\$0/i.test(t)) return true;
    if (/solicitar\s+oferta\s+de\s+\$0/i.test(t)) return true;
    if (/experimente\s+gr[aá]tis/i.test(t)) return true;
    if (t.includes('supergrok') && /\$0([,.]\d*)?/.test(t)) return true;
    if (/r\$\s*0([,.]\d*)?/.test(t) && /(trial|teste|gr[aá]tis|gratis|experimente|oferta)/i.test(t)) return true;
    if (/\$0([,.]\d*)?\s*(por|\/|per)\s*(m[eê]s|month|semana|week|dia|day)/i.test(t)) return true;
    if (/\d+\s*[- ]?day\s+free\s+trial/i.test(t)) return true;
    if (/\d+\s*dias?\s+(gr[aá]tis|free)/i.test(t)) return true;
    if (/try\s+(for\s+)?free/i.test(t)) return true;
    if (/experimente/.test(t) && (/\$0|gr[aá]tis|gratis/.test(t))) return true;
    return false;
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const isUpgradeOnly = (text) => {
    const t = norm(text);
    if (!t || hasOffer(t)) return false;
    return upgradeTexts.some((x) => t === x || t.startsWith(`${x} `));
  };

  const body = norm(document.body?.innerText);
  if (hasOffer(body)) return 'offer';

  const interactive = [...document.querySelectorAll('button, a, [role="button"], [role="link"]')];
  let sawUpgrade = false;
  for (const el of interactive) {
    if (!isVisible(el)) continue;
    const label = el.textContent || el.value || el.getAttribute('aria-label') || '';
    if (hasOffer(label)) return 'offer';
    if (isUpgradeOnly(label)) sawUpgrade = true;
  }

  // Banner fixo no rodape pode ser div/span (nao button).
  for (const el of document.querySelectorAll('[role="banner"], footer, div, span, p')) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const label = (el.textContent || '').trim();
    if (!label || label.length > 120) continue;
    if (hasOffer(label)) return 'offer';
  }

  return sawUpgrade ? 'upgrade' : 'none';
  /* eslint-enable no-undef */
}

/**
 * Debug: lista botoes visiveis e estado (browser context).
 */
export function probeTrialUi(offerTexts, upgradeTexts) {
  /* eslint-disable no-undef */
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const body = norm(document.body?.innerText || '').slice(0, 500);
  const buttons = [...document.querySelectorAll('button, a, [role="button"]')]
    .map((el) => {
      const r = el.getBoundingClientRect();
      const text = (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 80);
      return { text, w: Math.round(r.width), h: Math.round(r.height) };
    })
    .filter((b) => b.text && b.w > 0 && b.h > 0)
    .slice(0, 12);
  let state = 'none';
  try {
    state = evaluateTrialPageState(offerTexts, upgradeTexts);
  } catch {
    state = 'error';
  }
  return { state, bodySnippet: body, buttons };
  /* eslint-enable no-undef */
}

/**
 * Clica no CTA trial ($0.00 ou grátis).
 * IMPORTANTE: funcao autocontida — roda via page.evaluate (sem imports externos).
 * @returns {{ ok: boolean, tag?: string, text?: string }}
 */
export function trialOfferClickInPage(offerTexts) {
  /* eslint-disable no-undef */
  const onPlanPage =
    /#subscribe|\/plans|\/upgrade/i.test(location.href || '') ||
    !!document.querySelector('[data-testid="plan-cta-supergrok"]');
  if (onPlanPage) return { ok: false };

  window.scrollTo(0, document.body.scrollHeight);

  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const hasOffer = (text) => {
    const t = norm(text);
    if (!t) return false;
    if (offerTexts.some((x) => t.includes(x))) return true;
    if (/experimente\s+por\s+\$0([,.]\d*)?/i.test(t)) return true;
    if (/experimente\s+\d+\s+dias?\s+por\s+\$0/i.test(t)) return true;
    if (/solicitar\s+oferta\s+de\s+\$0/i.test(t)) return true;
    if (/experimente\s+gr[aá]tis/i.test(t)) return true;
    if (t.includes('supergrok') && /\$0([,.]\d*)?/.test(t)) return true;
    if (/r\$\s*0([,.]\d*)?/.test(t) && /(trial|teste|gr[aá]tis|gratis|experimente|oferta)/i.test(t)) return true;
    if (/\$0([,.]\d*)?\s*(por|\/|per)\s*(m[eê]s|month|semana|week|dia|day)/i.test(t)) return true;
    if (/\d+\s*[- ]?day\s+free\s+trial/i.test(t)) return true;
    if (/\d+\s*dias?\s+(gr[aá]tis|free)/i.test(t)) return true;
    return false;
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const isClickable = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a') return true;
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'link') return true;
    if (typeof el.onclick === 'function') return true;
    const style = window.getComputedStyle(el);
    return style.cursor === 'pointer';
  };
  const findClickTarget = (el) => {
    if (isClickable(el)) return el;
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      if (isClickable(node)) return node;
      node = node.parentElement;
    }
    const inner = el.querySelector('button, a, [role="button"], [role="link"]');
    return inner && isVisible(inner) ? inner : null;
  };
  const footerBonus = (el) => {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    return r.top > vh * 0.55 ? -1 : 0;
  };

  const candidates = [];
  const scan = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], footer *, [class*="banner" i], [class*="footer" i], [class*="sticky" i]',
  );
  for (const el of scan) {
    if (!isVisible(el)) continue;
    const label = (el.textContent || el.getAttribute('aria-label') || '').trim();
    if (!hasOffer(label) || norm(label).length > 120) continue;
    const target = findClickTarget(el);
    if (!target || !isVisible(target)) continue;
    const tag = target.tagName.toLowerCase();
    const priority = tag === 'button' ? 0 : tag === 'a' ? 1 : 2;
    candidates.push({
      el: target,
      len: norm(label).length,
      priority: priority + footerBonus(el),
      text: label.slice(0, 80),
    });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.len - b.len);
  if (candidates.length) {
    candidates[0].el.scrollIntoView({ block: 'center', inline: 'nearest' });
    candidates[0].el.click();
    return { ok: true, tag: candidates[0].el.tagName.toLowerCase(), text: candidates[0].text };
  }
  return { ok: false };
  /* eslint-enable no-undef */
}

/** Botoes pos-selecao do plano trial (continuar / assinar / checkout). */
export const TRIAL_PLAN_CONTINUE_TEXTS = [
  'continuar',
  'continue',
  'assinar',
  'subscribe',
  'iniciar assinatura',
  'start subscription',
  'proceed to checkout',
  'proceed',
  'ir para pagamento',
  'confirmar',
  'confirm',
  'começar',
  'comecar',
  'get started',
  'next',
  'próximo',
  'proximo',
  'checkout',
  'pagar agora',
  'pay now',
];

/** Toast/erro ao clicar "Solicitar oferta" na tela #subscribe. */
export const SUBSCRIBE_PROCESSING_ERROR_PATTERNS = [
  'algo deu errado durante o processamento',
  'something went wrong during the processing',
  'something went wrong processing your subscription',
  'error processing your subscription',
  'erro ao processar a sua assinatura',
  'erro ao processar sua assinatura',
  'unable to process your subscription',
  'nao foi possivel processar',
  'não foi possível processar',
];

/**
 * Detecta toast de erro de assinatura na tela de planos e tenta fechar (X).
 * IMPORTANTE: funcao autocontida — roda via page.evaluate.
 * @returns {{ hasError: boolean, message?: string, dismissed?: boolean }}
 */
export function dismissSubscribeProcessingErrorInPage(patterns) {
  /* eslint-disable no-undef */
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const matches = (text) => {
    const t = norm(text);
    return t && patterns.some((p) => t.includes(p));
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  const scan = document.querySelectorAll(
    '[role="alert"], [role="status"], [class*="toast" i], [class*="Toast" i], [data-sonner-toast], li[data-sonner-toast], [class*="notification" i]',
  );

  for (const el of scan) {
    if (!isVisible(el)) continue;
    const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
    if (!matches(text)) continue;

    const close =
      el.querySelector(
        'button[aria-label*="close" i], button[aria-label*="fechar" i], button[aria-label*="dismiss" i]',
      ) ||
      [...el.querySelectorAll('button')].find((b) => {
        const lbl = norm(b.textContent || b.getAttribute('aria-label') || '');
        return lbl === '×' || lbl === 'x' || lbl === 'close' || lbl === 'fechar' || lbl.length <= 2;
      });

    if (close && isVisible(close)) close.click();

    return { hasError: true, message: text.slice(0, 160), dismissed: !!close };
  }

  return { hasError: false };
  /* eslint-enable no-undef */
}

/**
 * Clica "Solicitar oferta de $0.00" na tela #subscribe (ignora banner do rodape).
 * IMPORTANTE: funcao autocontida — roda via page.evaluate.
 * @returns {{ ok: boolean, x?: number, y?: number, text?: string }}
 */
export function trialPlanOfferClickInPage(offerTexts) {
  /* eslint-disable no-undef */
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const isTrialOfferButton = (text) => {
    const t = norm(text);
    if (!t || t.length > 90) return false;
    if (t.includes('solicitar oferta de $0') || t.includes('solicitar oferta de $0,00')) return true;
    if (offerTexts.some((x) => t.includes(x) && (t.includes('solicitar') || t.includes('oferta')))) return true;
    if (/solicitar\s+oferta\s+(de\s+\$0|gratuita|gr[aá]tis)/i.test(t)) return true;
    return false;
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const inFooterBanner = (el) => {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    if (r.top > vh * 0.82) return true;
    let node = el;
    for (let i = 0; i < 8 && node; i++) {
      const tag = (node.tagName || '').toLowerCase();
      const cls = (node.className || '').toString().toLowerCase();
      const role = (node.getAttribute?.('role') || '').toLowerCase();
      if (tag === 'footer' || role === 'banner' || /footer|sticky|banner/.test(cls)) return true;
      node = node.parentElement;
    }
    return false;
  };

  window.scrollTo(0, 0);

  for (const byTestId of document.querySelectorAll('[data-testid="plan-cta-supergrok"]')) {
    if (!isVisible(byTestId)) continue;
    const label = (byTestId.innerText || byTestId.textContent || '').trim();
    if (!isTrialOfferButton(label)) continue;
    const r = byTestId.getBoundingClientRect();
    byTestId.scrollIntoView({ block: 'center', inline: 'nearest' });
    byTestId.click();
    return {
      ok: true,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      text: label.slice(0, 80),
    };
  }

  const candidates = [];
  for (const el of document.querySelectorAll('button, a, [role="button"], [role="link"]')) {
    if (!isVisible(el) || inFooterBanner(el)) continue;
    const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
    if (!isTrialOfferButton(label)) continue;
    const r = el.getBoundingClientRect();
    const score =
      norm(label).includes('solicitar oferta de $0') ? 0 : norm(label).includes('solicitar oferta') ? 1 : 2;
    candidates.push({
      el,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      score,
      text: label.slice(0, 80),
    });
  }
  candidates.sort((a, b) => a.score - b.score || a.y - b.y);
  if (!candidates.length) return { ok: false };

  // Clique no proprio elemento — NUNCA fallback para o 1o botao da pagina
  // (isso fechava o modal via X) nem mouse por coordenadas (infobar --no-sandbox).
  const pick = candidates[0];
  pick.el.scrollIntoView({ block: 'center', inline: 'nearest' });
  pick.el.click();
  return { ok: true, x: pick.x, y: pick.y, text: pick.text, clickedDom: true };
  /* eslint-enable no-undef */
}

/** Rotulos de CTA trial na tela #subscribe (nao confundir com Lite/Heavy/Melhorar). */
export function isTrialPlanButtonLabel(raw) {
  const t = normalizeTrialText(raw);
  if (!t || t.length > 120) return false;
  if (/supergrok\s+lite|supergrok\s+heavy|assinar\s+supergrok\s+lite/i.test(t)) return false;
  if (/melhorar|atualizar|upgrade|reivindicar|claim offer|subscribe for|atualizar para/i.test(t) && !/\$0/.test(t)) {
    return false;
  }
  if (/solicitar\s+oferta\s+(de\s+\$0|gratuita|gr[aá]tis)/i.test(t)) return true;
  if (/experimente.*\$0/i.test(t)) return true;
  if (trialTextMatches(t, TRIAL_OFFER_SUBSTRINGS) && /\$0|gr[aá]tis|gratis|gratuita/.test(t)) return true;
  return false;
}

/**
 * Stripe checkout: permite trial (7 dias grátis / Iniciar teste / Testar SuperGrok).
 * O valor "Depois R$ X/mês" e normal no trial — so bloqueia cobranca imediata no total.
 * IMPORTANTE: funcao autocontida — roda via page.evaluate.
 */
export function evaluateStripeCheckoutTrialInPage() {
  /* eslint-disable no-undef */
  const norm = (document.body?.innerText || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const onStripe =
    /checkout\.stripe\.com|stripe\.com\/(?:c\/)?pay|buy\.stripe|stripe\.com\/g\/pay/i.test(
      location.href || '',
    );

  const textOf = (sel) =>
    (document.querySelector(sel)?.innerText || '').toLowerCase().replace(/\s+/g, ' ').trim();

  const totalAmount = textOf('[data-testid="product-summary-total-amount"]');
  const productName = textOf('[data-testid="product-summary-name"]');
  const submitBtn = textOf('[data-testid="hosted-payment-submit-button"]');
  const lineItemTotal = textOf('[data-testid="line-item-total-amount"]');
  const hasCheckoutShell = !!document.querySelector(
    '[data-testid="checkout-container"], [data-testid="product-summary"], [data-testid="business-name"]',
  );

  // Checkout ainda carregando (URL Stripe mas shell/resumo ainda nao montou) — nao abortar.
  if (onStripe && !hasCheckoutShell && norm.length < 40) {
    return { ok: false, loading: true, reason: 'checkout Stripe ainda carregando' };
  }
  if (onStripe && hasCheckoutShell && !totalAmount && !productName && norm.length < 80) {
    return { ok: false, loading: true, reason: 'checkout Stripe montando resumo' };
  }
  // Shell existe mas trial indicators ainda nao — dar tempo (evita fechar instancia cedo).
  if (
    onStripe &&
    hasCheckoutShell &&
    !totalAmount &&
    !submitBtn &&
    !/testar|trial|gr[aá]tis|iniciar teste|lite|heavy|\$\s*(10|30|99)/i.test(norm)
  ) {
    return { ok: false, loading: true, reason: 'checkout Stripe aguardando conteudo' };
  }

  const trialAmountRe =
    /gr[aá]tis|gratis|free|days?\s+free|\$0([,.]00)?|r\$\s*0([,.]00)?|\d+\s+dias?\s+gr[aá]tis|\d+\s+days?\s+free/;
  const trialProductRe = /testar supergrok|try supergrok|trial|teste/i;
  const trialSubmitRe =
    /iniciar teste|start trial|come[cç]ar teste|iniciar avalia[cç][aã]o|start free trial/i;

  const hasPix =
    !!document.querySelector(
      '[data-testid="pix-accordion-item"], [data-testid="pix-accordion-item-button"], #payment-method-label-pix, input[value="pix"], input[type="radio"][value="pix"]',
    ) ||
    [...document.querySelectorAll('label, [role="radio"], span, div')].some((el) => {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return t === 'pix' || t === 'pagar com pix';
    });

  const parseBrlFromText = (t) => {
    const m = (t || '').match(/r\$\s*([\d.,]+)/i);
    if (!m) return null;
    const val = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(val) ? val : null;
  };

  const isTrialTotal = (t) => trialAmountRe.test(t || '');
  const isTrialDom =
    isTrialTotal(totalAmount) ||
    isTrialTotal(lineItemTotal) ||
    trialProductRe.test(productName) ||
    trialSubmitRe.test(submitBtn);

  // Shell externo do checkout novo (guacamole): "Testar SuperGrok" + "7 dias grátis".
  if (
    onStripe &&
    hasCheckoutShell &&
    (isTrialDom ||
      /7\s+dias\s+gr[aá]tis|testar supergrok|iniciar teste|start trial/i.test(norm))
  ) {
    return { ok: true };
  }

  if (onStripe && isTrialDom) {
    return { ok: true };
  }

  const bodyTrialRe =
    /7\s+dias\s+gr[aá]tis|\d+\s+dias\s+gr[aá]tis|testar supergrok|iniciar teste|start trial|teste gratuito|free trial/i;
  if (onStripe && bodyTrialRe.test(norm) && (hasPix || hasCheckoutShell || trialSubmitRe.test(norm))) {
    return { ok: true };
  }

  const strictPaidTitles = [
    'assinar supergrok lite',
    'assinar supergrok heavy',
    'atualizar para lite',
    'melhorar para o supergrok',
    'melhorar para supergrok',
    'reivindicar oferta',
  ];
  if (strictPaidTitles.some((h) => norm.includes(h))) {
    return { ok: false, reason: 'checkout Stripe plano pago (Lite/Heavy)' };
  }

  if (
    submitBtn &&
    /assinar|subscribe|pay now|pagar agora/.test(submitBtn) &&
    !trialSubmitRe.test(submitBtn)
  ) {
    return { ok: false, reason: 'checkout Stripe botao plano pago' };
  }

  // Cobranca imediata: total do pedido (nao o "Depois R$ X/mês" no corpo)
  if (totalAmount && !isTrialTotal(totalAmount)) {
    const dueNow = parseBrlFromText(totalAmount);
    if (dueNow !== null && dueNow > 0.01) {
      return { ok: false, reason: `checkout Stripe valor pago R$ ${dueNow.toFixed(2)}` };
    }
    if (/\$\s*(10|30|99|300)([,.]\d{2})?/.test(totalAmount)) {
      return { ok: false, reason: 'checkout Stripe USD pago' };
    }
  }

  if (
    lineItemTotal &&
    !isTrialTotal(lineItemTotal) &&
    parseBrlFromText(lineItemTotal) > 0.01
  ) {
    return { ok: false, reason: `checkout Stripe valor pago R$ ${parseBrlFromText(lineItemTotal).toFixed(2)}` };
  }

  if (/teste gratuito|free trial|iniciar teste|start trial|dias gr[aá]tis|testar supergrok/.test(norm)) {
    return { ok: true };
  }

  if (onStripe && hasPix && trialSubmitRe.test(norm)) {
    return { ok: true };
  }

  return { ok: false, reason: 'checkout Stripe sem trial $0' };
  /* eslint-enable no-undef */
}

/**
 * Detecta tela #subscribe so com planos pagos ($10/$30/$99) — sem CTA trial $0.
 * Pagina COM trial tambem tem Lite/$99 — nao marcar so por esses cards.
 * Fail-fast: se UI de planos ja montou e botao do meio nao e $0, retorna true.
 * IMPORTANTE: funcao autocontida — roda via page.evaluate.
 */
export function isPaidOnlySubscribePageInPage() {
  /* eslint-disable no-undef */
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const url = location.href || '';
  if (!/#subscribe|\/plans|\/upgrade|\/pricing/i.test(url)) return false;

  const body = norm(document.body?.innerText || '');

  // Tela com trial tambem tem Lite/Heavy — nao marcar paid-only se houver CTA $0.
  if (
    /solicitar\s+oferta\s+de\s+\$\s*0|solicitar\s+oferta\s+(gratuita|gr[aá]tis)|solicitar\s+oferta.*\$\s*0\.00|experimente\s+\$\s*0|experimente\s+\$0\.00|try\s+\$\s*0|\$0\.00\s*por\s+7|7\s*dias?\s*(por|gr[aá]tis).*\$\s*0|\d+\s+dias?\s+gratuitamente|oferta\s+por\s+tempo\s+limitado/i.test(
      body,
    )
  ) {
    return false;
  }

  const trialVisible = (() => {
    const byTestId = document.querySelector('[data-testid="plan-cta-supergrok"]');
    if (byTestId) {
      const r = byTestId.getBoundingClientRect();
      const style = window.getComputedStyle(byTestId);
      const visible =
        r.width > 8 &&
        r.height > 8 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden';
      if (visible) {
        const label = norm(byTestId.innerText || byTestId.textContent || '');
        if (/solicitar\s+oferta\s+(de\s+\$0|gratuita|gr[aá]tis)/i.test(label)) return true;
        if (/experimente.*\$0|experimente\s+gr[aá]tis/i.test(label)) return true;
        if (label.includes('solicitar oferta') && /\$0|0\.00|0,00/.test(label)) return true;
      }
    }
    const vh = window.innerHeight || 800;
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.top > vh * 0.9) continue;
      const t = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
      if (
        /solicitar\s+oferta\s+(de\s+\$0|gratuita|gr[aá]tis)/i.test(t) ||
        (t.includes('solicitar oferta') && /\$0|0\.00|0,00/.test(t)) ||
        (t.includes('experimente') && /\$0|0\.00|gr[aá]tis/.test(t))
      ) {
        return true;
      }
    }
    return false;
  })();

  if (trialVisible) return false;

  // Card do meio pago = "Melhorar para SuperGrok" / "Assinar SuperGrok" (sem botao $0)
  const middlePaid =
    /melhorar para (o )?supergrok|upgrade to (the )?supergrok|subscribe to (super)?grok|assinar\s+supergrok(?!\s+lite)/i.test(
      body,
    );
  const hasLite =
    /atualizar para lite|upgrade to lite|assinar\s+supergrok\s+lite|supergrok\s+lite/i.test(body);
  const hasHeavy = /supergrok\s+heavy|reivindicar oferta|claim offer/i.test(body);

  // UI de planos ja montada (Lite+Heavy) e meio pago → fail-fast sem trial.
  if (middlePaid && (hasLite || hasHeavy)) return true;

  // data-testid do CTA medio existe mas o texto e plano pago (nao $0)
  const midCta = document.querySelector('[data-testid="plan-cta-supergrok"]');
  if (midCta && hasLite && hasHeavy) {
    const r = midCta.getBoundingClientRect();
    const style = window.getComputedStyle(midCta);
    const visible =
      r.width > 8 &&
      r.height > 8 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden';
    if (visible) {
      const label = norm(midCta.innerText || midCta.textContent || '');
      if (
        label &&
        /melhorar|atualizar|upgrade|assinar|subscribe/i.test(label) &&
        !/\$0|0\.00|0,00|solicitar oferta|gr[aá]tis/.test(label)
      ) {
        return true;
      }
    }
  }

  if (!/\$\s*0(\.00)?|0,00/.test(body) && hasLite && hasHeavy && /\$\s*(10|30|99)/.test(body)) {
    return true;
  }

  return false;
  /* eslint-enable no-undef */
}

export function trialPlanOfferVisibleInPage() {
  /* eslint-disable no-undef */
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const isTrialLabel = (label) => {
    const t = norm(label);
    if (!t) return false;
    if (/melhorar|atualizar|lite|heavy|reivindicar/i.test(t) && !/\$0|0\.00|0,00/.test(t)) return false;
    if (/solicitar\s+oferta\s+(de\s+\$0|gratuita|gr[aá]tis)/i.test(t)) return true;
    if (/experimente.*\$0|experimente\s+gr[aá]tis/i.test(t)) return true;
    if (t.includes('solicitar oferta') && /\$0|0\.00|0,00/.test(t)) return true;
    return false;
  };

  for (const el of document.querySelectorAll('[data-testid="plan-cta-supergrok"]')) {
    if (!isVisible(el)) continue;
    if (isTrialLabel(el.innerText || el.textContent || '')) return true;
  }

  // Sem o testid do plano, so aceita botao generico se a URL for de planos.
  // Na home o banner "Experimente por $0.00" tambem casa com o matcher e
  // fazia o fluxo achar que o modal de planos ja estava aberto.
  if (!/#subscribe|\/plans|\/upgrade|\/subscribe|\/pricing/i.test(location.href || '')) {
    return false;
  }

  const vh = window.innerHeight || 800;
  for (const el of document.querySelectorAll('button, a, [role="button"]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.top > vh * 0.92) continue;
    if (isTrialLabel(el.innerText || el.textContent || el.getAttribute('aria-label') || '')) {
      return true;
    }
  }
  return false;
  /* eslint-enable no-undef */
}

/**
 * Detecta tela de planos Grok com CTA trial $0 (pre-Stripe).
 * IMPORTANTE: funcao autocontida — roda via page.evaluate.
 */
export function isOnTrialPlanScreenInPage(offerTexts) {
  /* eslint-disable no-undef */
  const url = location.href || '';
  if (/checkout\.stripe\.com/i.test(url)) return false;

  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const hasOffer = (text) => {
    const t = norm(text);
    if (!t) return false;
    if (offerTexts.some((x) => t.includes(x))) return true;
    if (/experimente\s+por\s+\$0([,.]\d*)?/i.test(t)) return true;
    if (/solicitar\s+oferta\s+de\s+\$0/i.test(t)) return true;
    if (/experimente\s+gr[aá]tis/i.test(t)) return true;
    if (t.includes('supergrok') && /\$0([,.]\d*)?/.test(t)) return true;
    return false;
  };

  if (/#subscribe|\/plans|\/upgrade|\/subscribe|\/pricing/i.test(url)) {
    const byTestId = document.querySelector('[data-testid="plan-cta-supergrok"]');
    if (byTestId) {
      const r = byTestId.getBoundingClientRect();
      const style = window.getComputedStyle(byTestId);
      const visible =
        r.width > 8 &&
        r.height > 8 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden';
      if (visible) {
        const label = norm(byTestId.innerText || byTestId.textContent || '');
        if (/solicitar\s+oferta\s+(de\s+\$0|gratuita|gr[aá]tis)/i.test(label)) return true;
        if (/experimente.*\$0|experimente\s+gr[aá]tis/i.test(label)) return true;
        if (label.includes('solicitar oferta') && /\$0|0\.00|0,00/.test(label)) return true;
      }
    }
    const vh = window.innerHeight || 800;
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.top > vh * 0.82) continue;
      const t = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
      if (
        t.includes('solicitar oferta') ||
        (t.includes('oferta') && /\$0|0\.00|0,00/.test(t)) ||
        (t.includes('experimente') && /\$0|0\.00|gr[aá]tis/.test(t))
      ) {
        return true;
      }
    }
    return false;
  }

  const body = norm(document.body?.innerText || '');
  const planHints =
    body.includes('supergrok') ||
    body.includes('plano') ||
    body.includes('plan') ||
    body.includes('pricing') ||
    body.includes('assinatura');
  if (planHints && hasOffer(body)) return true;

  const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="dialog" i]');
  for (const el of dialogs) {
    const t = norm(el.textContent || '');
    if (t.length > 40 && hasOffer(t)) return true;
  }
  return false;
  /* eslint-enable no-undef */
}

/**
 * Avanca da tela de planos trial para o checkout: card $0, CTA trial ou Continuar.
 * IMPORTANTE: funcao autocontida — roda via page.evaluate.
 * @returns {{ ok: boolean, step?: string, text?: string }}
 */
export function trialPlanAdvanceInPage(offerTexts, continueTexts) {
  /* eslint-disable no-undef */
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const hasOffer = (text) => {
    const t = norm(text);
    if (!t) return false;
    if (offerTexts.some((x) => t.includes(x))) return true;
    if (/experimente\s+por\s+\$0([,.]\d*)?/i.test(t)) return true;
    if (/experimente\s+\d+\s+dias?\s+por\s+\$0/i.test(t)) return true;
    if (/solicitar\s+oferta\s+de\s+\$0/i.test(t)) return true;
    if (/experimente\s+gr[aá]tis/i.test(t)) return true;
    if (t.includes('supergrok') && /\$0([,.]\d*)?/.test(t)) return true;
    if (/r\$\s*0([,.]\d*)?/.test(t) && /(trial|teste|gr[aá]tis|gratis|experimente|oferta)/i.test(t)) return true;
    if (/\$0([,.]\d*)?\s*(por|\/|per)\s*(m[eê]s|month|semana|week|dia|day)/i.test(t)) return true;
    if (/\d+\s*[- ]?day\s+free\s+trial/i.test(t)) return true;
    if (/\d+\s*dias?\s+(gr[aá]tis|free)/i.test(t)) return true;
    return false;
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const isClickable = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a') return true;
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'link') return true;
    if (typeof el.onclick === 'function') return true;
    const style = window.getComputedStyle(el);
    return style.cursor === 'pointer';
  };
  const findClickTarget = (el) => {
    if (isClickable(el)) return el;
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      if (isClickable(node)) return node;
      node = node.parentElement;
    }
    const inner = el.querySelector('button, a, [role="button"], [role="link"]');
    return inner && isVisible(inner) ? inner : null;
  };
  const clickEl = (el, step, text) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.click();
    return { ok: true, step, text: String(text || '').slice(0, 80) };
  };

  window.scrollTo(0, 0);

  const byTestId = document.querySelector('[data-testid="plan-cta-supergrok"]');
  if (byTestId && isVisible(byTestId)) {
    return clickEl(byTestId, 'testid', (byTestId.innerText || byTestId.textContent || '').trim());
  }

  const onPlanPage = /#subscribe|\/plans|\/upgrade/i.test(location.href || '');

  // 1) Botoes "Solicitar oferta de $0.00" (nao banner do rodape)
  const trialCandidates = [];
  const scan = document.querySelectorAll('button, a, [role="button"], [role="link"]');
  for (const el of scan) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    if (onPlanPage && r.top > vh * 0.82) continue;
    const label = (el.textContent || el.getAttribute('aria-label') || '').trim();
    if (!hasOffer(label) || norm(label).length > 120) continue;
    const target = findClickTarget(el);
    if (!target || !isVisible(target)) continue;
    const tag = target.tagName.toLowerCase();
    const nlabel = norm(label);
    let priority = tag === 'button' ? 0 : tag === 'a' ? 1 : 2;
    if (nlabel.includes('solicitar oferta de $0')) priority -= 3;
    else if (nlabel.includes('solicitar oferta')) priority -= 2;
    trialCandidates.push({ el: target, priority, len: nlabel.length, text: label.slice(0, 80) });
  }
  trialCandidates.sort((a, b) => a.priority - b.priority || a.len - b.len);
  if (trialCandidates.length) return clickEl(trialCandidates[0].el, 'offer', trialCandidates[0].text);

  if (onPlanPage) return { ok: false };

  // fallback home: banner/rodape
  const homeScan = document.querySelectorAll(
    'footer *, [class*="banner" i], [class*="footer" i], [class*="sticky" i]',
  );
  for (const el of homeScan) {
    if (!isVisible(el)) continue;
    const label = (el.textContent || el.getAttribute('aria-label') || '').trim();
    if (!hasOffer(label) || norm(label).length > 120) continue;
    const target = findClickTarget(el);
    if (!target || !isVisible(target)) continue;
    return clickEl(target, 'offer', label.slice(0, 80));
  }

  // 2) Cards de plano (container com trial $0)
  const cardSelectors =
    '[class*="plan" i], [class*="pricing" i], [class*="card" i], article, [data-testid*="plan"], [role="dialog"] *';
  for (const el of document.querySelectorAll(cardSelectors)) {
    const label = (el.textContent || '').trim();
    if (!hasOffer(label) || norm(label).length > 500) continue;
    if (!isVisible(el)) continue;
    const target = findClickTarget(el) || el.querySelector('button, a, [role="button"]');
    if (!target || !isVisible(target)) continue;
    return clickEl(target, 'card', label.slice(0, 80));
  }

  // 3) Continuar / assinar / checkout
  for (const el of document.querySelectorAll('button, a, [role="button"], input[type="submit"]')) {
    if (!isVisible(el)) continue;
    const label = norm(el.textContent || el.value || el.getAttribute('aria-label') || '');
    if (!label || label.length > 80) continue;
    if (continueTexts.some((c) => label.includes(c))) {
      return clickEl(el, 'continue', label);
    }
  }

  return { ok: false };
  /* eslint-enable no-undef */
}
