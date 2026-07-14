import fs from 'node:fs';
import path from 'node:path';
import { config } from '../shared/config.js';
import { loadAccounts } from '../shared/accounts.js';
import { launchBrowser, setupPage } from '../shared/browser.js';
import { getInstanceProxy, maskProxy } from '../shared/proxy.js';
import { createLogger } from '../shared/logger.js';
import { loginGrok } from '../shared/grokLogin.js';
import { sleep } from '../shared/pageHelpers.js';

/**
 * Mapeia UI de checkout/PIX apos login com trial visivel.
 *   npm run probe:subscribe
 *   node scripts/probe-subscribe.js --limit=1
 *
 * Gera screenshots/probe-subscribe.png e imprime botoes/inputs visiveis.
 */
const log = createLogger('probe-subscribe');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

async function dumpPageState(page) {
  return page.evaluate(() => {
    /* eslint-disable no-undef */
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const buttons = Array.from(
      document.querySelectorAll('button, a, [role="button"], input[type="submit"]'),
    )
      .filter(visible)
      .slice(0, 40)
      .map((el) => ({
        tag: el.tagName,
        text: (el.innerText || el.value || '').trim().slice(0, 120),
        id: el.id || null,
        className: (el.className || '').toString().slice(0, 80),
        href: el.href || null,
      }));

    const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter(visible)
      .slice(0, 40)
      .map((el) => ({
        tag: el.tagName,
        type: el.type || null,
        name: el.name || null,
        id: el.id || null,
        placeholder: el.placeholder || null,
        autocomplete: el.getAttribute('autocomplete'),
        ariaLabel: el.getAttribute('aria-label'),
      }));

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .filter(visible)
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean)
      .slice(0, 15);

    const bodySnippet = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);

    const hasEmv = /000201[\dA-Za-z./\-+:]{20,}/.test(document.body?.innerText || '');

    return { buttons, inputs, headings, bodySnippet, hasEmv };
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const accounts = loadAccounts(config.accountsFile);
  const limit = parseInt(args.limit, 10) || 1;
  const account = accounts[0];

  if (!account) {
    log.error('Nenhuma conta em', config.accountsFile);
    process.exit(1);
  }

  log.info('Conta:', account.email);
  log.info('Use conta NOVA com trial visivel na 1a vez.');

  const proxy = getInstanceProxy({ seed: `probe-sub-${account.email}` });
  log.info('Proxy:', maskProxy(proxy));

  const browser = await launchBrowser({ proxy, log });
  try {
    const page = await setupPage(browser, { proxy, log });
    const login = await loginGrok(page, account, { proxy, log });

    log.info('Login ok:', login.ok, '| trial:', login.trialDetected, '|', login.reason);
    log.info('URL:', page.url());

    await sleep(1500);
    const state = await dumpPageState(page);

    fs.mkdirSync(config.screenshotDir, { recursive: true });
    const shot = path.join(config.screenshotDir, 'probe-subscribe.png');
    await page.screenshot({ path: shot, fullPage: true });
    log.info('Screenshot:', shot);

    console.log('\n=== HEADINGS ===');
    state.headings.forEach((h) => console.log(' -', h));

    console.log('\n=== BUTTONS (primeiros 40) ===');
    state.buttons.forEach((b, i) => {
      console.log(` [${i}] <${b.tag}> "${b.text}" id=${b.id} class=${b.className}`);
    });

    console.log('\n=== INPUTS ===');
    state.inputs.forEach((inp, i) => {
      console.log(
        ` [${i}] <${inp.tag}> type=${inp.type} name=${inp.name} id=${inp.id} placeholder=${inp.placeholder}`,
      );
    });

    console.log('\n=== EMV PIX na pagina? ===', state.hasEmv);
    console.log('\n=== BODY (trecho) ===\n', state.bodySnippet.slice(0, 800));

    console.log('\n=== SELECTORS sugeridos (.env) ===');
    console.log('# SEL_TRIAL_CTA=...');
    console.log('# SEL_PAYMENT_PIX=...');
    console.log('# SEL_PAYER_NAME=...');
    console.log('# SEL_PAYER_CPF=...');
    console.log('# SEL_SUBSCRIBE_SUBMIT=...');
    console.log('# SEL_PIX_COPY=...');
    console.log('# SEL_PIX_QR=canvas, img[alt*="QR"]');

    if (!login.trialDetected) {
      log.warn('Trial NAO detectado — use conta nova ou proxy melhor.');
    }

    if (config.keepBrowserOpen) {
      log.info('KEEP_BROWSER_OPEN=true -> Ctrl+C para sair.');
      await new Promise(() => {});
    }
  } catch (e) {
    log.error('Falha:', e.message);
    process.exitCode = 1;
  } finally {
    if (!config.keepBrowserOpen) await browser.close();
  }
}

main();
