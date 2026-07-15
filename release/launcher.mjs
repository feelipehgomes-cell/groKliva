import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.dirname(fileURLToPath(import.meta.url));
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);

if (nodeMajor < 18) {
  console.error('');
  console.error(`[KLIVA] Node.js ${process.version} detectado.`);
  console.error('[KLIVA] E necessario Node.js 18 ou superior (recomendado: 20 LTS).');
  console.error('[KLIVA] Baixe em: https://nodejs.org/');
  console.error('[KLIVA] Depois de instalar, feche e abra o terminal e rode iniciar.bat de novo.');
  console.error('');
  process.exit(1);
}

process.env.KLIVA_ROOT = root;
process.env.KLIVA_RELEASE = '1';

dotenv.config({ path: path.join(root, '.env'), override: false });

await import('./app/run-server.mjs');
