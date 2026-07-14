import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT = path.join(ROOT, 'bot');

const REPLACEMENTS = {
  './config.js': '../config.js',
  './logger.js': '../logger.js',
  './pool.js': '../pool.js',
  './browser.js': '../browser/browser.js',
  './pageHelpers.js': '../browser/pageHelpers.js',
  './turnstile.js': '../browser/turnstile.js',
  './grokLogin.js': '../grok/grokLogin.js',
  './grokSignup.js': '../grok/grokSignup.js',
  './grokSubscribe.js': '../grok/grokSubscribe.js',
  './trialOffer.js': '../grok/trialOffer.js',
  './stripeDiag.js': '../grok/stripeDiag.js',
  './pixExtract.js': '../pix/pixExtract.js',
  './payer.js': '../pix/payer.js',
  './payerStore.js': '../pix/payerStore.js',
  './paidStore.js': '../pix/paidStore.js',
  './cpf.js': '../pix/cpf.js',
  './accounts.js': '../accounts/accounts.js',
  './generatorEmail.js': '../accounts/generatorEmail.js',
  './names.js': '../accounts/names.js',
  './whatsapp.js': '../whatsapp/whatsapp.js',
  './whatsappBaileys.js': '../whatsapp/whatsappBaileys.js',
  './subscribeActivity.js': '../whatsapp/subscribeActivity.js',
  './proxy.js': '../proxy/proxy.js',
};

function fixSharedSubdir(content) {
  let out = content;
  for (const [from, to] of Object.entries(REPLACEMENTS)) {
    out = out.replaceAll(`from '${from}'`, `from '${to}'`);
  }
  return out;
}

function fixSharedRoot(content, file) {
  if (file.endsWith('pool.js')) {
    let out = content;
    for (const [from, to] of Object.entries(REPLACEMENTS)) {
      out = out.replaceAll(`from '${from}'`, `from '${to}'`);
    }
    out = out.replace(
      "from '../accounts/accounts.js'",
      "from './accounts/accounts.js'",
    );
    out = out.replace("from '../../activate/worker.js'", "from '../../activate/worker.js'");
    out = out.replace("from '../activate/worker.js'", "from '../../activate/worker.js'");
    out = out.replace("from './worker.js'", "from '../../activate/worker.js'");
    return out;
  }
  return content;
}

function fixBotWorker(content) {
  let out = content;
  for (const [from, to] of Object.entries(REPLACEMENTS)) {
    const target = to.replace('../', '../shared/');
    out = out.replaceAll(`from '${from}'`, `from '${target}'`);
  }
  return out;
}

function fixScripts(content) {
  let out = content;
  for (const [from, to] of Object.entries(REPLACEMENTS)) {
    const target = '../shared/' + to.replace(/^\.\.\//, '');
    out = out.replaceAll(`from '${from}'`, `from '${target}'`);
  }
  out = out.replaceAll("from '../src/", "from '../shared/");
  return out;
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (!entry.name.endsWith('.js')) continue;
    else {
      let content = fs.readFileSync(full, 'utf8');
      const rel = path.relative(BOT, full).replace(/\\/g, '/');

      if (rel.startsWith('shared/') && !rel.match(/^shared\/(config|logger|pool)\.js$/)) {
        content = fixSharedSubdir(content);
      } else if (rel === 'shared/pool.js') {
        content = fixSharedRoot(content, full);
        content = fixSharedSubdir(content);
        content = content.replace(
          "from '../accounts/accounts.js'",
          "from './accounts/accounts.js'",
        );
        content = content.replace(
          "from '../../activate/worker.js'",
          "from '../../activate/worker.js'",
        );
        if (!content.includes('../../activate/worker.js')) {
          content = content.replace(
            /from '\.\/worker\.js'/,
            "from '../../activate/worker.js'",
          );
        }
      } else if (rel.endsWith('generate/worker.js') || rel.endsWith('activate/worker.js')) {
        content = fixBotWorker(content);
      } else if (rel.startsWith('scripts/')) {
        content = fixScripts(content);
      }

      fs.writeFileSync(full, content);
      console.log('fixed', rel);
    }
  }
}

walk(BOT);
