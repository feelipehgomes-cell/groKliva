import { detectStripePixOnPage } from '../pix/pixExtract.js';

/**
 * Monitora rede/console do Stripe checkout para descobrir por que o QR PIX some.
 */
export function attachStripeDiagnostics(page, log) {
  const state = {
    failures: [],
    responses: [],
    consoleErrors: [],
  };

  const onResponse = async (response) => {
    try {
      const url = response.url();
      if (!/stripe\.com/i.test(url)) return;

      const status = response.status();
      const entry = { url: url.slice(0, 200), status, at: Date.now() };

      if (status >= 400) {
        let body = '';
        try {
          body = await response.text();
        } catch {
          /* noop */
        }
        const snippet = body.slice(0, 500);
        entry.body = snippet;
        state.failures.push(entry);
        log?.warn?.(`Stripe HTTP ${status}: ${url.split('?')[0].slice(-80)}`);
        if (snippet) log?.warn?.(`  corpo: ${snippet.replace(/\s+/g, ' ').slice(0, 180)}`);
      } else if (
        /confirm|payment|pix|checkout|intent/i.test(url) &&
        status >= 200 &&
        status < 300
      ) {
        state.responses.push(entry);
      }
    } catch {
      /* noop */
    }
  };

  const onConsole = (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = msg.text();
    if (!text || !/stripe|payment|pix|error/i.test(text)) return;
    state.consoleErrors.push({ type, text: text.slice(0, 300), at: Date.now() });
  };

  page.on('response', onResponse);
  page.on('console', onConsole);

  return {
    state,
    detach() {
      page.off('response', onResponse);
      page.off('console', onConsole);
    },
    getSummary() {
      return {
        httpFailures: state.failures.slice(-5),
        recentOk: state.responses.slice(-5),
        consoleErrors: state.consoleErrors.slice(-5),
      };
    },
  };
}

/** Lê erros visíveis na UI do Stripe após o QR sumir. */
export async function readStripeUiState(page) {
  try {
    const pix = await detectStripePixOnPage(page);
    return await page.evaluate(
      (pixState) => {
        /* eslint-disable no-undef */
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const alerts = Array.from(
          document.querySelectorAll(
            [
              '[role="alert"]',
              '[class*="Error" i]',
              '.ConfirmPaymentButton-Error',
              '.Notice--red',
              '.Notice-message',
              '.Notice.Notice--red',
            ].join(', '),
          ),
        )
          .map((el) => norm(el.innerText))
          .filter((t) => t.length > 3 && t.length < 400);

        const body = document.body?.innerText || '';
        const placeholder = /c[oó]digo qr ser[aá] exibido|revelar c[oó]digo qr/i.test(body);
        const btn = document.querySelector('[data-testid="hosted-payment-submit-button"]');
        const btnText = norm(btn?.innerText);

        return {
          alerts: [...new Set(alerts)],
          hasEmv: pixState.hasEmv,
          hasCanvas: false,
          hasQrImg: pixState.hasQrImg,
          placeholder,
          processing: pixState.processing,
          btnText,
          url: location.href.slice(0, 120),
        };
        /* eslint-enable no-undef */
      },
      { hasEmv: pix.hasEmv, hasQrImg: pix.hasQrImg, processing: pix.processing },
    );
  } catch (e) {
    return { alerts: [], error: e.message };
  }
}

/** "Seu cartão foi recusado. Tente usar outro." (e variantes EN). */
export function isCardDeclinedMessage(text) {
  const t = String(text || '');
  return (
    /cart[aã]o\s+foi\s+recusado/i.test(t) ||
    /card\s+(was\s+)?declined/i.test(t) ||
    (/recusado/i.test(t) && /outro/i.test(t)) ||
    (/declined/i.test(t) && /another|other/i.test(t))
  );
}

/**
 * Procura erro de cartao/CPF recusado na pagina Stripe e iframes de pagamento.
 * @returns {Promise<string|null>} texto do erro ou null
 */
export async function detectCardDeclinedError(page) {
  if (!page) return null;

  const collectFrom = async (ctx) => {
    try {
      return await ctx.evaluate(() => {
        /* eslint-disable no-undef */
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const nodes = Array.from(
          document.querySelectorAll(
            [
              '.ConfirmPaymentButton-Error',
              '.Notice--red',
              '.Notice-message',
              '[role="alert"]',
              '[class*="Error" i]',
            ].join(', '),
          ),
        );
        const fromNodes = nodes.map((el) => norm(el.innerText)).filter(Boolean);
        const body = norm(document.body?.innerText || '').slice(0, 800);
        return { fromNodes, body };
        /* eslint-enable no-undef */
      });
    } catch {
      return null;
    }
  };

  const contexts = [page];
  try {
    for (const frame of page.frames?.() || []) {
      if (frame !== page.mainFrame?.()) contexts.push(frame);
    }
  } catch {
    /* noop */
  }

  for (const ctx of contexts) {
    const hit = await collectFrom(ctx);
    if (!hit) continue;
    for (const msg of hit.fromNodes || []) {
      if (isCardDeclinedMessage(msg)) return msg;
    }
    if (isCardDeclinedMessage(hit.body)) {
      const m = hit.body.match(
        /[^.?!]*(?:cart[aã]o\s+foi\s+recusado|card\s+(?:was\s+)?declined)[^.?!]*[.?!]?/i,
      );
      return (m?.[0] || hit.body).trim().slice(0, 200);
    }
  }

  return null;
}

export function logStripeUiState(ui, log) {
  if (!log || !ui) return;
  if (ui.alerts?.length) log.warn(`Stripe UI: ${ui.alerts.join(' | ')}`);
  log.info(
    `Stripe estado: emv=${ui.hasEmv} qr=${ui.hasQrImg} placeholder=${ui.placeholder} processing=${ui.processing} botao="${ui.btnText || '?'}"`,
  );
}
