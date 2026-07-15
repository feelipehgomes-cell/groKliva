#!/usr/bin/env node
/**
 * Gera chave de licenca para um comprador (uso interno — nao incluir no pacote).
 *
 * Uso:
 *   npm run license:generate -- --email=cliente@email.com --days=365
 *   npm run license:generate -- --email=cliente@email.com --days=30 --machine
 *
 * Requer LICENSE_SIGNING_SECRET no .env (mesmo valor usado em npm run release).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
const bindMachine = process.argv.includes('--machine');

if (!email) {
  console.error('Uso: npm run license:generate -- --email=cliente@email.com --days=365 [--machine]');
  process.exit(1);
}

function getMachineId() {
  const raw = [
    os.hostname(),
    os.userInfo().username,
    os.platform(),
    os.arch(),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

const payload = {
  v: 1,
  email,
  exp: Date.now() + days * 24 * 60 * 60 * 1000,
};

if (bindMachine) {
  payload.mid = getMachineId();
  console.log(`[license] Vinculada a esta maquina (mid=${payload.mid})`);
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
