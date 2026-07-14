import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { sleep } from '../browser/pageHelpers.js';
import { isBrowserConnected } from '../proxy/proxy.js';

/** EMV PIX (aceita espacos no nome do recebedor, ex. "Ebanx LTDA"). */
export const EMV_RE = /000201[\dA-Za-z./\-+: *]{30,}6304[0-9A-Fa-f]{4}/;

const STRIPE_QR_IMG_SELECTORS = [
  'img[data-testid="QRCode-image-downloadable"]',
  'img[data-testid="QRCode-image"]',
  'img.QRCode-image--downloadable',
  'img.QRCode-image',
  'img[src*="qr.stripe.com"]',
];

const STRIPE_EMV_SELECTORS = [
  '[class*="QrDataText"] span',
  '[class*="QrDataText"]',
];

const EMPTY_STATE = {
  hasEmv: false,
  hasQrImg: false,
  hasPix: false,
  copyPaste: null,
  qrImgSrc: null,
  qrSelector: null,
  processing: false,
};

function detectPixInDom(emvSource, qrSels, emvSels) {
  /* eslint-disable no-undef */
  const emvRe = new RegExp(emvSource);
  const visible = (el) => {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 40;
  };

  let copyPaste = null;
  for (const sel of emvSels) {
    for (const el of document.querySelectorAll(sel)) {
      const t = (el.innerText || el.textContent || '').trim();
      const m = t.match(emvRe);
      if (m) {
        copyPaste = m[0];
        break;
      }
    }
    if (copyPaste) break;
  }
  if (!copyPaste) {
    const m = (document.body?.innerText || '').match(emvRe);
    if (m) copyPaste = m[0];
  }

  let qrImgSrc = null;
  let qrSelector = null;
  for (const sel of qrSels) {
    const el = document.querySelector(sel);
    if (!el || !visible(el)) continue;
    if (el.tagName === 'IMG' && el.src) {
      qrImgSrc = el.src;
      qrSelector = sel;
      break;
    }
    if (el.tagName === 'CANVAS') {
      qrSelector = sel;
      break;
    }
  }

  const processing =
    document.querySelector('[data-testid="submit-button-processing-label"]')?.getAttribute(
      'aria-hidden',
    ) === 'false';

  const hasEmv = Boolean(copyPaste);
  const hasQrImg = Boolean(qrImgSrc || qrSelector);
  return { hasEmv, hasQrImg, hasPix: hasEmv || hasQrImg, copyPaste, qrImgSrc, qrSelector, processing };
  /* eslint-enable no-undef */
}

async function detectInFrame(frame) {
  try {
    return await frame.evaluate(
      detectPixInDom,
      EMV_RE.source,
      STRIPE_QR_IMG_SELECTORS,
      STRIPE_EMV_SELECTORS,
    );
  } catch {
    return { ...EMPTY_STATE };
  }
}

/**
 * Busca PIX em todas as abas/frames (Stripe pode estar em outra aba ou iframe).
 */
export async function detectStripePixContext(browser, page, log) {
  let stripePage = page;
  if (browser) {
    try {
      const { resolveStripeCheckoutPage } = await import('./browser.js');
      stripePage = await resolveStripeCheckoutPage(browser, page, log);
    } catch {
      /* noop */
    }
  }

  const networkEmv = stripePage?.__pixEmvFromNetwork || null;
  if (networkEmv) {
    return {
      page: stripePage,
      frame: stripePage.mainFrame(),
      state: { ...EMPTY_STATE, hasEmv: true, hasPix: true, copyPaste: networkEmv },
    };
  }

  const frames = stripePage.frames();
  for (const frame of frames) {
    const state = await detectInFrame(frame);
    if (state.hasPix) {
      log?.debug?.(`PIX detectado no frame: ${frame.url().slice(0, 80)}`);
      return { page: stripePage, frame, state };
    }
  }

  return { page: stripePage, frame: stripePage.mainFrame(), state: { ...EMPTY_STATE } };
}

export async function detectStripePixOnPage(page, { browser, log } = {}) {
  const ctx = await detectStripePixContext(browser, page, log);
  return ctx.state;
}

/** Detecta PIX visivel so no DOM (ignora EMV em cache da rede). */
export async function detectPixVisibleOnly(browser, page, log) {
  let stripePage = page;
  if (browser) {
    try {
      const { resolveStripeCheckoutPage } = await import('./browser.js');
      stripePage = await resolveStripeCheckoutPage(browser, page, log);
    } catch {
      /* noop */
    }
  }

  for (const frame of stripePage.frames()) {
    const state = await detectInFrame(frame);
    if (state.hasPix) return true;
  }
  return false;
}

const PAYMENT_SUCCESS_TERMS = [
  'pagamento confirmado',
  'pagamento realizado',
  'pago com sucesso',
  'payment successful',
  'payment complete',
  'payment succeeded',
  'thank you for your payment',
  'obrigado pelo pagamento',
];

const STRIPE_QR_SELECTORS = [
  'img[data-testid="QRCode-image-downloadable"]',
  'img[data-testid="QRCode-image"]',
  'img.QRCode-image--downloadable',
  'img.QRCode-image',
  'img[src*="qr.stripe.com"]',
];

function isStripeCheckoutUrl(url = '') {
  return /checkout\.stripe\.com|stripe\.com\/(?:c\/)?pay|buy\.stripe|stripe\.com\/g\/pay/i.test(
    url,
  );
}

function isGrokHomeUrl(url = '') {
  return /grok\.com/i.test(url) && !/checkout\.stripe|accounts\.x\.ai/i.test(url);
}

/**
 * Modal pos-pagamento PIX: "Voce desbloqueou:" + SuperGrok onboarding.
 * Sinal forte de ativacao — so aparece apos pagamento confirmado.
 */
export async function detectSuperGrokActivation(browser, page, log) {
  const pages = browser ? await browser.pages().catch(() => [page]) : [page];

  for (const p of pages) {
    if (!p || (typeof p.isClosed === 'function' && p.isClosed())) continue;

    let url = '';
    try {
      url = p.url();
    } catch {
      continue;
    }
    if (!isGrokHomeUrl(url)) continue;

    try {
      const hit = await p.evaluate(() => {
        /* eslint-disable no-undef */
        const isVisible = (el) => {
          if (!el) return false;
          const st = window.getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };

        const dialogMatches = (dlg) => {
          if (!isVisible(dlg)) return false;
          const txt = (dlg.innerText || dlg.textContent || '').toLowerCase();
          const hasUnlock = txt.includes('desbloqueou') || txt.includes('unlocked');
          const hasCta =
            txt.includes('comece a curtir o supergrok') ||
            txt.includes('start enjoying supergrok');
          const hasFeature =
            txt.includes('inteligência ilimitada') ||
            txt.includes('inteligencia ilimitada') ||
            txt.includes('unlimited intelligence');
          const hasOnboardingMedia = !!dlg.querySelector(
            'video[src*="supergrok-onboarding"], img[src*="supergrok-onboarding"], source[src*="supergrok-onboarding"]',
          );
          return hasOnboardingMedia || (hasUnlock && (hasCta || hasFeature));
        };

        for (const dlg of document.querySelectorAll('[role="dialog"][data-state="open"]')) {
          if (dialogMatches(dlg)) return true;
        }
        for (const dlg of document.querySelectorAll('[role="dialog"]')) {
          if (dialogMatches(dlg)) return true;
        }

        const body = (document.body?.innerText || '').toLowerCase();
        return (
          (body.includes('você desbloqueou:') || body.includes('voce desbloqueou:')) &&
          (body.includes('comece a curtir o supergrok') ||
            body.includes('inteligência ilimitada') ||
            body.includes('inteligencia ilimitada'))
        );
        /* eslint-enable no-undef */
      });

      if (hit) {
        log?.info?.('SuperGrok ativado — modal de onboarding detectado.');
        return { ok: true, reason: 'supergrok-onboarding-modal' };
      }
    } catch {
      /* noop */
    }
  }

  return { ok: false };
}

/**
 * Confirmacao estrita — Stripe succeeded OU modal SuperGrok pos-pagamento.
 * Ignora grok.com generico (aba de login) sem o modal de ativacao.
 */
export async function detectStrictPaymentSuccess(browser, page, log) {
  const activation = await detectSuperGrokActivation(browser, page, log);
  if (activation.ok) return activation;

  const pages = browser ? await browser.pages().catch(() => [page]) : [page];

  for (const p of pages) {
    if (!p || (typeof p.isClosed === 'function' && p.isClosed())) continue;

    let url = '';
    try {
      url = p.url();
    } catch {
      continue;
    }

    if (/redirect_status=succeeded|payment_intent=.*succeeded/i.test(url)) {
      return { ok: true, reason: 'stripe-redirect-succeeded' };
    }

    if (!isStripeCheckoutUrl(url)) continue;

    try {
      const hit = await p.evaluate(
        (terms, qrSels) => {
          /* eslint-disable no-undef */
          const visible = (el) => {
            if (!el) return false;
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            return r.width >= 40 && r.height >= 40;
          };

          for (const sel of qrSels) {
            const el = document.querySelector(sel);
            if (el && visible(el)) return false;
          }

          const txt = (document.body?.innerText || '').toLowerCase();
          return terms.some((t) => txt.includes(t));
          /* eslint-enable no-undef */
        },
        PAYMENT_SUCCESS_TERMS,
        STRIPE_QR_SELECTORS,
      );
      if (hit) return { ok: true, reason: 'stripe-success-text' };
    } catch {
      /* noop */
    }
  }

  return { ok: false };
}

/** @deprecated Use detectStrictPaymentSuccess — mantido para compatibilidade interna. */
export async function detectPaymentSuccess(browser, page, log) {
  return detectStrictPaymentSuccess(browser, page, log);
}

/** Ultimos 4 caracteres do EMV PIX (CRC apos 6304). */
export function pixEmvLast4(copyPaste) {
  const emv = String(copyPaste || '').trim();
  if (!emv) return null;
  const m = emv.match(/6304([0-9A-Fa-f]{4})$/i);
  if (m) return m[1].toUpperCase();
  return emv.slice(-4).toUpperCase();
}

/** Escuta respostas Stripe e guarda EMV se vier na API (log uma vez). */
export function attachPixNetworkCapture(page, log) {
  if (page.__pixNetworkAttached) {
    return page.__pixNetworkDetach || (() => {});
  }
  page.__pixNetworkAttached = true;
  page.__pixEmvFromNetwork = null;

  const onResponse = async (response) => {
    if (page.__pixEmvFromNetwork) return;
    try {
      const url = response.url();
      if (!/stripe\.com/i.test(url)) return;
      if (!/payment|pix|confirm|intent|charge/i.test(url)) return;
      const text = await response.text();
      const m = text.match(EMV_RE);
      if (!m) return;
      page.__pixEmvFromNetwork = m[0];
      log?.info?.(`EMV capturado da rede Stripe (${m[0].length} chars).`);
      page.off('response', onResponse);
      page.__pixNetworkAttached = false;
    } catch {
      /* noop */
    }
  };

  page.on('response', onResponse);
  const detach = () => page.off('response', onResponse);
  page.__pixNetworkDetach = detach;
  return detach;
}

/** Captura PIX assim que EMV/QR aparecer — sem esperar 20s pela imagem do Stripe. */
export async function capturePixOnce(page, { email, log, browser, waitMs = 8000 } = {}) {
  const start = Date.now();

  while (Date.now() - start < waitMs) {
    const ctx = await detectStripePixContext(browser, page, log);
    page = ctx.page;

    if (ctx.state.hasPix) {
      const pix = await extractPixData(ctx.page, {
        email,
        log,
        state: ctx.state,
        frame: ctx.frame,
      });
      if (pix.copyPaste || pix.qrImagePath) {
        const parts = [];
        if (pix.copyPaste) parts.push('emv');
        if (pix.qrImagePath) parts.push('imagem');
        log?.info?.(`PIX capturado (${parts.join(' + ') || 'ok'}).`);
        return pix;
      }
    }

    await sleep(150);
  }

  return null;
}

export async function waitForPixAndExtract(page, { email, log, browser, timeoutMs = config.pixGenerateWaitMs } = {}) {
  return capturePixOnce(page, { email, log, browser, waitMs: timeoutMs });
}

export async function waitForPixGone(page, { browser, log, timeoutMs = config.paymentWaitCycleMs } = {}) {
  const start = Date.now();
  let hadPixVisible = false;
  let goneStreak = 0;
  const goneStreakRequired = Math.max(0, config.paymentGoneStreakSec);

  while (Date.now() - start < timeoutMs) {
    if (browser && !(await isBrowserConnected(browser))) {
      log?.warn?.('Browser desconectado durante espera do PIX.');
      return { paid: false, reason: 'browser-disconnected' };
    }

    const success = await detectStrictPaymentSuccess(browser, page, log);
    if (success.ok) {
      log?.info?.(`Pagamento confirmado (${success.reason}).`);
      return { paid: true, reason: success.reason };
    }

    const visible = await detectPixVisibleOnly(browser, page, log);
    if (visible) {
      hadPixVisible = true;
      goneStreak = 0;
    } else if (hadPixVisible && goneStreakRequired > 0) {
      goneStreak += 1;
      if (goneStreak >= goneStreakRequired) {
        log?.info?.(`QR PIX ausente por ${goneStreakRequired}s (apos exibicao).`);
        return { paid: true, reason: 'qr-gone-sustained' };
      }
    }

    await sleep(1000);
  }

  return { paid: false };
}

export async function extractPixData(page, { email, log, state, frame } = {}) {
  const ctx = state
    ? { page, frame: frame || page.mainFrame(), state }
    : await detectStripePixContext(null, page, log);

  let copyPaste = ctx.state.copyPaste || null;
  const shotFrame = ctx.frame || page.mainFrame();

  if (!copyPaste) {
    try {
      copyPaste = await shotFrame.evaluate(
        (emvSource, emvSels) => {
          /* eslint-disable no-undef */
          const re = new RegExp(emvSource);
          const sources = [];
          document.querySelectorAll('input, textarea').forEach((el) => {
            const v = (el.value || '').trim();
            if (v) sources.push(v);
          });
          for (const sel of emvSels) {
            document.querySelectorAll(sel).forEach((el) => {
              const t = (el.innerText || el.textContent || '').trim();
              if (t.length > 40) sources.push(t);
            });
          }
          sources.push(document.body?.innerText || '');
          for (const s of sources) {
            const m = s.match(re);
            if (m) return m[0];
          }
          return null;
          /* eslint-enable no-undef */
        },
        EMV_RE.source,
        STRIPE_EMV_SELECTORS,
      );
    } catch {
      /* noop */
    }
  }

  let qrImagePath = null;
  const selectors = [
    ...STRIPE_QR_IMG_SELECTORS,
    ...config.selectors.pixQrImage.split(',').map((s) => s.trim()).filter(Boolean),
  ];

  for (const sel of selectors) {
    qrImagePath = await shotQrElement(shotFrame, page, sel, email, log);
    if (qrImagePath) break;
  }

  // Stripe entrega SVG — nao usar; ensureQrImagePath gera PNG do EMV.
  if (qrImagePath?.toLowerCase().endsWith('.svg')) qrImagePath = null;

  if (!qrImagePath && ctx.state.qrImgSrc && !ctx.state.qrImgSrc.includes('.svg')) {
    qrImagePath = await downloadQrFromUrl(page, ctx.state.qrImgSrc, email, log);
  }

  if (!copyPaste && !qrImagePath) {
    try {
      fs.mkdirSync(config.screenshotDir, { recursive: true });
      const safeEmail = String(email || 'unknown').replace(/[^a-z0-9]/gi, '_').slice(0, 40);
      qrImagePath = path.join(config.screenshotDir, `pix-page-${safeEmail}-${Date.now()}.png`);
      await page.screenshot({ path: qrImagePath, fullPage: true });
      log?.warn?.('PIX EMV/QR nao encontrado; screenshot full-page salvo.');
    } catch {
      /* noop */
    }
  }

  if (copyPaste) log?.info?.(`EMV copia-e-cola: ${copyPaste.length} caracteres.`);
  if (qrImagePath) log?.info?.(`QR imagem: ${path.basename(qrImagePath)}`);

  qrImagePath = await ensureQrImagePath({ copyPaste, qrImagePath, email, log });

  return { copyPaste, qrImagePath, qrBase64: null };
}

/** Gera PNG escaneavel a partir do EMV (fallback quando Stripe so entrega SVG/rede). */
export async function ensureQrImagePath({ copyPaste, qrImagePath, email, log } = {}) {
  if (qrImagePath && fs.existsSync(qrImagePath) && !qrImagePath.toLowerCase().endsWith('.svg')) {
    return qrImagePath;
  }
  if (!copyPaste) return qrImagePath || null;

  try {
    fs.mkdirSync(config.screenshotDir, { recursive: true });
    const safeEmail = String(email || 'unknown').replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    const file = path.join(config.screenshotDir, `pix-qrgen-${safeEmail}-${Date.now()}.png`);
    await QRCode.toFile(file, copyPaste, { width: 512, margin: 2, errorCorrectionLevel: 'M' });
    log?.info?.(`QR PNG gerado do EMV: ${path.basename(file)}`);
    return file;
  } catch (e) {
    log?.warn?.(`Falha ao gerar QR do EMV: ${e.message}`);
    return qrImagePath || null;
  }
}

async function shotQrElement(frame, page, selector, email, log) {
  try {
    const el = await frame.$(selector);
    if (!el) return null;
    const box = await el.boundingBox();
    if (!box || box.width < 40 || box.height < 40) return null;

    fs.mkdirSync(config.screenshotDir, { recursive: true });
    const safeEmail = String(email || 'unknown').replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    const file = path.join(config.screenshotDir, `pix-${safeEmail}-${Date.now()}.png`);
    await el.screenshot({ path: file });
    log?.debug?.('QR screenshot:', file);
    return file;
  } catch (e) {
    log?.debug?.(`screenshot QR (${selector}) falhou:`, e.message);
    return null;
  }
}

async function downloadQrFromUrl(page, url, email, log) {
  try {
    const bytes = await page.evaluate(async (imgUrl) => {
      /* eslint-disable no-undef */
      const res = await fetch(imgUrl);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      return Array.from(new Uint8Array(buf));
      /* eslint-enable no-undef */
    }, url);

    if (!bytes?.length) return null;

    fs.mkdirSync(config.screenshotDir, { recursive: true });
    const safeEmail = String(email || 'unknown').replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    const ext = url.includes('.svg') ? '.svg' : '.png';
    const file = path.join(config.screenshotDir, `pix-${safeEmail}-${Date.now()}${ext}`);
    fs.writeFileSync(file, Buffer.from(bytes));
    log?.debug?.('QR baixado:', url.slice(0, 80));
    return file;
  } catch (e) {
    log?.debug?.('download QR falhou:', e.message);
    return null;
  }
}
