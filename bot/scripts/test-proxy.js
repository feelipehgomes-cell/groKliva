import { launchBrowser, setupPage } from '../shared/browser.js';
import { getInstanceProxy, maskProxy, probePublicIp, verifyProxyWithRetry } from '../shared/proxy.js';
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';

/**
 * Valida proxy + sessoes unicas por instancia.
 *   node scripts/test-proxy.js
 *   node scripts/test-proxy.js 4
 */
const log = createLogger('test-proxy');
const count = Math.max(1, parseInt(process.argv[2], 10) || 3);

if (!config.proxyUrl) {
  log.error('PROXY_URL vazia. Coloque usuario:senha@host:porta em PROXY_URL no .env');
  process.exit(1);
}

log.info(`proxyUrl: ${config.proxyUrl.replace(/:([^:@/]+)@/, ':***@')}`);
log.info(`session template: ${config.proxySessionTemplate}`);

async function checkOne(slot) {
  const seed = `slot-${slot}-${Date.now()}`;
  const proxy = getInstanceProxy({ seed });

  log.info(`[${slot}] ${maskProxy(proxy)} session=${proxy?.sessionId || '-'}`);

  const browser = await launchBrowser({ proxy, log, profileKey: `test-proxy-${slot}` });
  try {
    const page = await setupPage(browser, { proxy, log });
    const tunnel = await verifyProxyWithRetry(page, log);
    if (!tunnel.ok) {
      log.error(`[${slot}] Tunel HTTPS falhou: ${tunnel.reason}`);
      return { slot, ip: null, error: tunnel.reason, username: proxy?.username };
    }
    const ip = await probePublicIp(page);
    log.info(`[${slot}] IP: ${ip}`);
    return { slot, ip, sessionId: proxy?.sessionId, username: proxy?.username };
  } catch (e) {
    log.error(`[${slot}] Falha: ${e.message}`);
    return { slot, ip: null, error: e.message, username: proxy?.username };
  } finally {
    await browser.close().catch(() => {});
  }
}

const results = [];
for (let i = 1; i <= count; i++) {
  results.push(await checkOne(i));
}

const ips = results.map((r) => r.ip).filter(Boolean);
const unique = new Set(ips);
console.log('');
log.info(`IPs obtidos: ${ips.join(', ') || '(nenhum)'}`);
log.info(`Unicos: ${unique.size}/${ips.length}`);

if (ips.length === 0) {
  log.error(
    'Nenhum IP obtido — verifique saldo/credenciais da proxy (Lightning HTTP 402 = sem credito).',
  );
  process.exit(1);
}

if (ips.length >= 2 && unique.size < ips.length) {
  log.error('PROBLEMA: instancias compartilham o mesmo IP — sessao sticky nao esta funcionando.');
  process.exit(1);
}

if (ips.length >= 2 && unique.size === ips.length) {
  log.info('OK: cada instancia usou IP diferente.');
}
