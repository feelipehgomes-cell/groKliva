import fs from 'node:fs';
import path from 'node:path';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import {
  clearBaileysAuth,
  connectBaileysSavedSession,
  connectBaileysWithQr,
  hasSavedSession,
} from '../shared/whatsapp/whatsappBaileys.js';

/**
 * Login WhatsApp sempre por QR:
 *   npm run whatsapp:login              # escaneia QR (PNG em screenshots/)
 *   npm run whatsapp:login -- --force   # apaga sessao e gera QR novo
 *   npm run whatsapp:connect            # so reconecta sessao salva (sem QR)
 */
const log = createLogger('whatsapp-login');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

async function showQr(qr) {
  fs.mkdirSync(config.screenshotDir, { recursive: true });
  const pngPath = path.join(config.screenshotDir, 'whatsapp-login-qr.png');
  await qrcode.toFile(pngPath, qr, { width: 400 });
  console.log('\n=== QR CODE ===\n');
  qrcodeTerminal.generate(qr, { small: true });
  console.log(`\nQR salvo em: ${pngPath}`);
  console.log('Celular: WhatsApp > Dispositivos conectados > Conectar dispositivo > Escanear QR\n');
}

async function warnIfKlivaRunning() {
  const port = config.klivaPort || 4000;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return;
    log.warn('');
    log.warn('ATENCAO: KLIVA esta rodando (dev:kliva ou start:kliva).');
    log.warn('Pare o servidor com Ctrl+C ANTES do login — dois processos na pasta');
    log.warn('whatsapp-auth/ impedem o escaneamento do QR.');
    log.warn('');
  } catch {
    /* servidor parado — ok */
  }
}

const args = parseArgs(process.argv);
const force = args.force === true || args.force === 'true';
const connectOnly = args.connect === true || args.connect === 'true';

await warnIfKlivaRunning();

if (force && hasSavedSession()) {
  log.warn('Apagando sessao antiga em', config.whatsappAuthDir);
  clearBaileysAuth();
}

log.info('Pasta de auth:', config.whatsappAuthDir);

const loginTimeoutMs = 600000;

try {
  if (connectOnly) {
    await connectBaileysSavedSession({ log, timeoutMs: loginTimeoutMs });
  } else {
    log.info('Modo QR — escaneie o codigo no celular.');
    await connectBaileysWithQr({
      log,
      timeoutMs: loginTimeoutMs,
      onQr: (qr) => {
        showQr(qr).catch((e) => log.warn('QR:', e.message));
      },
    });
  }

  log.info('Conectado! Rode: npm run whatsapp:groups');
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(0);
} catch (err) {
  log.error('Falha:', err.message);
  log.info('');
  log.info('Passos recomendados:');
  log.info('  1. Pare o dev:kliva (Ctrl+C) se estiver rodando');
  log.info('  2. npm run whatsapp:login -- --force');
  log.info('  3. Escaneie o QR em screenshots/whatsapp-login-qr.png');
  process.exit(1);
}
