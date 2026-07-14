import fs from 'node:fs';
import path from 'node:path';
import { config } from '../shared/config.js';
import { launchBrowser, setupPage } from '../shared/browser.js';
import { getInstanceProxy } from '../shared/proxy.js';
import { createLogger } from '../shared/logger.js';
import { loginGrok } from '../shared/grokLogin.js';
import {
  dismissCookieBanner,
  dismissChromeOverlays,
  sleep,
  gotoWithRetry,
  clickByText,
} from '../shared/pageHelpers.js';
import {
  evaluateTrialPageState,
  TRIAL_OFFER_SUBSTRINGS,
  TRIAL_UPGRADE_ONLY,
} from '../shared/trialOffer.js';

/**
 * Mapeia trial em varias URLs (home, plans, pos-Aprimorar).
 *   node scripts/probe-trial-pages.js email@dominio.com
 */
const log = createLogger('probe-trial-pages');

function parseArgs(argv) {
  const email = argv[2];
  const password = argv[3] || config.signupPassword;
  return { email, password };
}

async function dumpPageState(page) {
  return page.evaluate(() => {
    /* eslint-disable no-undef */
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };

    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return visible(el) && r.width > 2 && r.height > 2;
      })
      .slice(0, 35)
      .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 100))
      .filter(Boolean);

    const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2500);
    return { buttons, body };
  });
}

async function probeUrl(page, label, url) {
  if (url) await gotoWithRetry(page, url, { log, timeout: 25000 });
  await dismissCookieBanner(page);
  await clickByText(page, ['fechar', 'close'], { timeout: 1500 }).catch(() => {});
  await sleep(1200);

  const state = await page
    .evaluate(evaluateTrialPageState, TRIAL_OFFER_SUBSTRINGS, TRIAL_UPGRADE_ONLY)
    .catch(() => 'error');
  const { buttons, body } = await dumpPageState(page);

  console.log(`\n=== ${label} ===`);
  console.log('URL:', page.url());
  console.log('Trial state:', state);
  console.log('Buttons:', buttons.join(' | '));
  console.log('Body:', body.slice(0, 900));

  fs.mkdirSync(config.screenshotDir, { recursive: true });
  const safe = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const shot = path.join(config.screenshotDir, `probe-trial-${safe}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  console.log('Screenshot:', shot);
}

async function main() {
  const { email, password } = parseArgs(process.argv);
  if (!email) {
    console.error('Uso: node scripts/probe-trial-pages.js email@dominio.com [senha]');
    process.exit(1);
  }

  log.info('Conta:', email);
  const proxy = getInstanceProxy({ seed: `probe-trial-${email}` });
  const browser = await launchBrowser({ proxy, log });

  try {
    const page = await setupPage(browser, { proxy, log });
    const login = await loginGrok(page, { email, password }, { proxy, log });
    log.info('Login:', login.ok, '| trial detectado no fluxo padrao:', login.trialDetected);

    // pos-login sem re-navegar (ja esta na home)
    await probeUrl(page, 'home-pos-login', null);

    await probeUrl(page, 'plans', 'https://grok.com/plans');
    await probeUrl(page, 'upgrade', 'https://grok.com/upgrade');

    await gotoWithRetry(page, config.postLoginUrl, { log });
    await dismissCookieBanner(page);
    await clickByText(page, ['aprimorar', 'upgrade'], { timeout: 3000 });
    await sleep(1500);
    await probeUrl(page, 'pos-clique-aprimorar', null);

    if (config.keepBrowserOpen) {
      log.info('KEEP_BROWSER_OPEN=true -> Ctrl+C para sair.');
      await new Promise(() => {});
    }
  } finally {
    if (!config.keepBrowserOpen) await browser.close();
  }
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
