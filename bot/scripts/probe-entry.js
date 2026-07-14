import { config } from '../shared/config.js';
import { launchBrowser, setupPage } from '../shared/browser.js';
import { getInstanceProxy, maskProxy } from '../shared/proxy.js';
import { createLogger } from '../shared/logger.js';
import { sleep, hasTurnstile, hasTurnstileToken } from '../shared/pageHelpers.js';

/**
 * Smoke test: abre a pagina de login do Grok e dumpa estado basico.
 *   node scripts/probe-entry.js
 */
const log = createLogger('probe');

const proxy = getInstanceProxy({ seed: 'probe' });
log.info('Proxy:', maskProxy(proxy));
log.info('Login URL:', config.loginUrl);

const browser = await launchBrowser({ proxy, log });
try {
  const page = await setupPage(browser, { proxy, log });
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  log.info('URL atual:', page.url());
  log.info('UA:', page.__userAgent);
  log.info('Tem Turnstile?', await hasTurnstile(page));
  log.info('Token Turnstile?', await hasTurnstileToken(page));

  const hasEmail = await page.$(config.selectors.emailInput);
  log.info('Campo de email presente?', !!hasEmail);
} catch (e) {
  log.error('Falha:', e.message);
} finally {
  if (!config.keepBrowserOpen) await browser.close();
}
