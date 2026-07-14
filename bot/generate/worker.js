import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { getInstanceProxy, maskProxy } from '../shared/proxy/proxy.js';
import {
  launchBrowser,
  setupPage,
  closeBrowser,
  clearAuthStorage,
  parseWindowSlot,
  focusPage,
  screenshot,
} from '../shared/browser/browser.js';
import { signUpAccount, isTrialOfferAvailable } from '../shared/grok/grokSignup.js';
import { appendAccount } from '../shared/accounts/accounts.js';
import { createEmailAddress } from '../shared/accounts/generatorEmail.js';
import { generateFakeName } from '../shared/accounts/names.js';
import { sleep } from '../shared/browser/pageHelpers.js';

/**
 * Gera UMA conta nova numa instancia isolada de browser.
 * Cada worker: gera email temporario + proxy dedicada, sobe browser, cadastra, fecha tudo.
 *
 * @param {object} opts - { workerId }
 * @returns {Promise<object>} resultado
 */
export async function generateAccount({ workerId } = {}) {
  const tag = `gen ${workerId}`;
  const log = createLogger(tag);

  const maxRetries = Math.max(0, config.maxRetriesPerAccount);
  let lastResult = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) log.warn(`Retry ${attempt}/${maxRetries}...`);

    // email + nome novos a cada tentativa
    const email = createEmailAddress();
    const { firstName, lastName } = generateFakeName({
      firstName: config.signupFirstName,
      lastName: config.signupLastName,
    });
    const account = {
      email,
      password: config.signupPassword,
      firstName,
      lastName,
    };

    const proxy = getInstanceProxy({ seed: `${workerId}-${email}-${attempt}` });
    log.info(
      `Novo cadastro: ${email} (${firstName} ${lastName}). Proxy: ${maskProxy(proxy)}${proxy?.sessionId ? ` (session ${proxy.sessionId})` : ''}`,
    );

    let browser;
    try {
      browser = await launchBrowser({
        proxy,
        log,
        profileKey: `${workerId}-${email}-${attempt}-${Date.now()}`,
        windowSlot: parseWindowSlot(workerId),
      });
      const page = await setupPage(browser, { proxy, log });
      await focusPage(page, log);
      await clearAuthStorage(page, log);

      const started = Date.now();
      const result = await signUpAccount(page, account, { proxy, log });
      const durationMs = Date.now() - started;

      lastResult = {
        email,
        password: config.signupPassword,
        firstName,
        lastName,
        ok: result.ok,
        reason: result.reason,
        url: result.url,
        proxy: maskProxy(proxy),
        durationMs,
        attempt: attempt + 1,
        at: new Date().toISOString(),
      };

      if (result.ok) {
        const trialAvailable = await isTrialOfferAvailable(page, { log });
        lastResult.trialAvailable = trialAvailable;

        if (!trialAvailable) {
          lastResult.ok = false;
          lastResult.savedToFile = false;
          lastResult.reason =
            'trial ($0.00) indisponivel — x.ai so mostrou planos pagos (Aprimorar). Conta nao salva.';
          log.warn(
            `Conta criada mas SEM trial ($0.00) — NAO salva. (${durationMs}ms) ` +
              'Dica: trial e por cohorte/regiao; emails descartaveis podem nao receber oferta.',
          );
          await screenshot(
            page,
            `no-trial-${email.replace(/[^a-z0-9]/gi, '_')}`,
            log,
          );
          await closeBrowser(browser, log, {
            cleanupProfile: config.chromeFreshProfile,
          });
          if (attempt < maxRetries) {
            await sleep(800);
            continue;
          }
          return lastResult;
        }

        const saved = await appendAccount({
          email,
          password: config.signupPassword,
          firstName,
          lastName,
        });
        lastResult.savedToFile = saved;
        log.info(
          `SUCESSO em ${durationMs}ms (trial OK).${saved ? ` Conta salva em ${config.generatedAccountsFile}.` : ' (ja existia no arquivo)'}`,
        );

        if (config.keepBrowserOpen) {
          log.info('KEEP_BROWSER_OPEN=true -> mantendo browser aberto.');
          return lastResult;
        }
        await closeBrowser(browser, log, {
          cleanupProfile: config.chromeFreshProfile,
        });
        return lastResult;
      }

      log.warn(`FALHA: ${result.reason}`);
      await closeBrowser(browser, log, {
        cleanupProfile: config.chromeFreshProfile,
      });
    } catch (err) {
      log.error(`Erro na instancia: ${err.message}`);
      lastResult = {
        email,
        firstName,
        lastName,
        ok: false,
        reason: `erro: ${err.message}`,
        proxy: maskProxy(proxy),
        attempt: attempt + 1,
        at: new Date().toISOString(),
      };
      await closeBrowser(browser, log, {
        cleanupProfile: config.chromeFreshProfile,
      });
    }

    if (attempt < maxRetries) await sleep(800);
  }

  return lastResult;
}
