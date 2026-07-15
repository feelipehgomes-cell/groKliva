#!/usr/bin/env node
/**
 * Gera chave de licenca para um comprador (uso interno — nao incluir no pacote).
 *
 * Uso:
 *   npm run license:generate -- --email=cliente@email.com --days=365
 *   npm run license:generate -- --email=cliente@email.com --days=365 --machine-id=a3f8b2c1d4e5f678
 *
 * Anti-repasse (1 PC):
 *   1. Cliente roda codigo-ativacao.bat e te manda o codigo
 *   2. Voce gera com --machine-id=<codigo do cliente>
 *
 * Requer LICENSE_SIGNING_SECRET no .env (mesmo valor usado em npm run release).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(ROOT, '.env') });

const secret = (process.env.LICENSE_SIGNING_SECRET || '').trim();
if (!secret) {
  console.error('Defina LICENSE_SIGNING_SECRET no .env antes de gerar licencas.');
  process.exit(1);
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=') || '';
}

const email = arg('email').trim();
const days = parseInt(arg('days') || '365', 10);
const machineId = arg('machine-id').trim().toLowerCase();

if (!email) {
  console.error('Uso: npm run license:generate -- --email=cliente@email.com --days=365 [--machine-id=CODIGO]');
  process.exit(1);
}

if (process.argv.includes('--machine') && !machineId) {
  console.error('');
  console.error('[license] --machine sozinho vincula ao SEU PC (desenvolvedor), nao ao do cliente.');
  console.error('[license] Fluxo correto:');
  console.error('[license]   1. Cliente roda codigo-ativacao.bat e te envia o codigo');
  console.error('[license]   2. npm run license:generate -- --email=... --days=... --machine-id=CODIGO');
  console.error('');
  process.exit(1);
}

if (machineId && !/^[a-f0-9]{16}$/.test(machineId)) {
  console.error('[license] --machine-id invalido (esperado: codigo de 16 caracteres, ex: a3f8b2c1d4e5f678)');
  process.exit(1);
}

const payload = {
  v: 1,
  email,
  exp: Date.now() + days * 24 * 60 * 60 * 1000,
};

if (machineId) {
  payload.mid = machineId;
  console.log(`[license] Vinculada ao codigo de ativacao do cliente (${machineId})`);
}

const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
const key = `KLIVA.${payloadB64}.${sig}`;

console.log('\n[license] Chave gerada:\n');
console.log(key);
console.log(`\n[license] Email: ${email}`);
console.log(`[license] Expira: ${new Date(payload.exp).toLocaleString('pt-BR')}`);
console.log('\n[license] O cliente cola em KLIVA_LICENSE_KEY no .env\n');

const outDir = path.join(ROOT, 'dist-release', 'licenses');
fs.mkdirSync(outDir, { recursive: true });
const safeEmail = email.replace(/[^a-z0-9@._-]/gi, '_');
const outFile = path.join(outDir, `${safeEmail}-${Date.now()}.txt`);
fs.writeFileSync(outFile, `${key}\n`, 'utf8');
console.log(`[license] Salva em: ${outFile}\n`);
