import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from '../config.js';

/**
 * Carrega contas de um arquivo JSON ou CSV.
 *
 * JSON: [{ "email": "...", "password": "..." }, ...]
 * CSV : email,password  (uma por linha, cabecalho opcional)
 *
 * Retorna array de { email, password, ...extra }.
 */
export function loadAccounts(file = config.accountsFile) {
  const full = path.isAbsolute(file) ? file : path.join(ROOT_DIR, file);
  if (!fs.existsSync(full)) {
    return [];
  }

  const raw = fs.readFileSync(full, 'utf8').trim();
  if (!raw) return [];

  const ext = path.extname(full).toLowerCase();
  let accounts;
  if (ext === '.json') {
    accounts = parseJson(raw);
  } else {
    accounts = parseCsv(raw);
  }

  return accounts
    .map((a, i) => normalizeAccount(a, i))
    .filter((a) => a.email && a.password);
}

/** Parse contas a partir de texto (txt colado ou importado). */
export function parseAccountsText(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const trimmed = text;
  let accounts;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      accounts = parseJson(trimmed);
    } catch {
      return [];
    }
  } else {
    accounts = parseCsv(trimmed);
  }

  return accounts
    .map((a, i) => normalizeAccount(a, i))
    .filter((a) => a.email && a.password);
}

function parseJson(raw) {
  const data = JSON.parse(raw);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.accounts)) return data.accounts;
  throw new Error('JSON de contas deve ser um array ou { accounts: [...] }.');
}

function parseCsv(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')); // ignora vazias e comentarios
  if (!lines.length) return [];

  // Cabecalho: so e header se NAO tiver '@' (linhas de dados sempre tem email).
  const first = lines[0].toLowerCase();
  const looksLikeHeader =
    !lines[0].includes('@') &&
    (first.includes('email') || first.includes('user') || first.includes('login') || first.includes('senha'));
  const rows = looksLikeHeader ? lines.slice(1) : lines;

  return rows.map((line) => {
    const parts = splitCsvLine(line);
    return { email: parts[0], password: parts[1] };
  });
}

function splitCsvLine(line) {
  // suporta separadores | ; , tab (nessa ordem de prioridade).
  // formato principal do projeto: email|senha|  (pipe no final -> campo vazio ignorado)
  for (const sep of ['|', ';', ',', '\t']) {
    if (line.includes(sep)) {
      // extras (ex.: pipe final gerando campo vazio) sao ignorados: usamos parts[0] e parts[1]
      return line.split(sep).map((s) => s.trim());
    }
  }
  // fallback: email:password -> split no ultimo ':'
  const idx = line.lastIndexOf(':');
  if (idx > 0) return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  return [line.trim()];
}

function normalizeAccount(a, index) {
  const email = a.email || a.user || a.username || a.login || '';
  const password = a.password || a.pass || a.senha || '';
  return {
    ...a,
    index: index + 1,
    email: String(email).trim(),
    password: String(password),
  };
}

/** Email/senha rejeitados pelo site — nao adianta retry na mesma conta. */
export function isInvalidLoginCredentials(reason) {
  if (!reason) return false;
  const t = String(reason).toLowerCase();
  const patterns = [
    'invalid email',
    'invalid password',
    'incorrect password',
    'wrong password',
    'invalid credentials',
    'could not sign',
    "couldn't sign",
    'unable to sign',
    'failed to sign',
    'sign in failed',
    'authentication failed',
    'senha incorreta',
    'senha inválida',
    'senha invalida',
    'email ou senha',
    'e-mail ou senha',
    'e-mail ou senha incorretos',
    'email ou senha incorretos',
    'incorretos',
    'incorreto',
    'incorrect email or password',
    'wrong email or password',
    'credenciais inválidas',
    'credenciais invalidas',
    'usuário não encontrado',
    'usuario nao encontrado',
    'user not found',
    'conta não existe',
    'account not found',
    'does not exist',
    'email invalido',
    'email inválido',
    'invalid user',
    'campo de senha nao encontrado (email invalido',
    'unable to authenticate',
    'not authorized',
    'incorrect email',
  ];
  return patterns.some((p) => t.includes(p));
}

/** Assinatura PIX falhou porque a conta nao tem trial (CTA $0.00 ausente). */
export function isNoTrialSubscribeFailure(reason) {
  if (!reason) return false;
  const t = String(reason).toLowerCase();
  return [
    'cta do trial nao encontrado',
    'trial nao encontrado',
    'sem trial',
    'planos pagos',
    'checkout stripe pago',
    'checkout stripe valor pago',
    'checkout stripe plano pago',
    'supergrok lite',
    'cta trial $0.00',
  ].some((p) => t.includes(p));
}

/** Falha na fase subscribe (pre-PIX): plano trial, Grok toast, CTA planos. */
export function isSubscribePhaseFailure(reason) {
  if (!reason) return false;
  const t = String(reason).toLowerCase();
  return [
    'travado na selecao do plano',
    'grok: erro ao processar',
    'tela de planos nao carregou',
    'cta do trial nao encontrado',
    'algo deu errado durante o processamento',
    'erro ao processar assinatura',
  ].some((p) => t.includes(p));
}

/**
 * Remove linhas do arquivo de contas pelos emails informados.
 * Serializado (seguro com CONCURRENCY > 1).
 * @returns {Promise<number>} quantidade removida
 */
export function removeAccountsFromFile(emailsToRemove, file = config.accountsFile) {
  const task = accountsFileQueue.then(() => removeAccountsFromFileSync(emailsToRemove, file));
  accountsFileQueue = task.then(() => {}, () => {});
  return task;
}

function removeAccountsFromFileSync(emailsToRemove, file = config.accountsFile) {
  const full = path.isAbsolute(file) ? file : path.join(ROOT_DIR, file);
  if (!fs.existsSync(full)) return 0;

  const remove = new Set(
    (Array.isArray(emailsToRemove) ? emailsToRemove : [emailsToRemove])
      .map((e) => String(e || '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (!remove.size) return 0;

  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  let removed = 0;
  const kept = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      kept.push(line);
      continue;
    }
    const email = splitCsvLine(trimmed)[0]?.trim().toLowerCase();
    if (email && remove.has(email)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }

  const out = kept.length ? `${kept.join('\n')}\n` : '';
  fs.writeFileSync(full, out, 'utf8');
  return removed;
}

let accountsFileQueue = Promise.resolve();

/**
 * Adiciona uma conta nova ao arquivo de contas (append serializado, seguro com CONCURRENCY > 1).
 * Formato: email|senha|Nome Sobrenome
 *
 * @returns {Promise<boolean>} false se o email ja existia no arquivo.
 */
export function appendAccount({ email, password, firstName = '', lastName = '' }, file = config.generatedAccountsFile) {
  const task = accountsFileQueue.then(() => {
    const full = path.isAbsolute(file) ? file : path.join(ROOT_DIR, file);
    const normEmail = String(email || '').trim();
    if (!normEmail || !password) return false;

    let existing = '';
    if (fs.existsSync(full)) existing = fs.readFileSync(full, 'utf8');

    const already = existing
      .split(/\r?\n/)
      .some((line) => splitCsvLine(line.trim())[0]?.trim().toLowerCase() === normEmail.toLowerCase());
    if (already) return false;

    const fullName = [firstName, lastName].filter(Boolean).join(' ');
    const row = `${normEmail}|${password}|${fullName}`;
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(full, `${prefix}${row}\n`, 'utf8');
    return true;
  });

  accountsFileQueue = task.then(() => {}, () => {});
  return task;
}

/**
 * Grava resultados mesclando por email (nao apaga sessoes anteriores ao parar/reiniciar).
 */
export function saveResults(results, file = config.resultsFile) {
  const full = path.isAbsolute(file) ? file : path.join(ROOT_DIR, file);
  let existing = [];
  if (fs.existsSync(full)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      existing = Array.isArray(parsed) ? parsed : [];
    } catch {
      existing = [];
    }
  }

  const byEmail = new Map();
  for (const row of existing) {
    const key = String(row?.email || '').toLowerCase();
    if (key) byEmail.set(key, row);
  }
  for (const row of results) {
    const key = String(row?.email || '').toLowerCase();
    if (!key) continue;
    const prev = byEmail.get(key);
    byEmail.set(key, prev ? { ...prev, ...row } : row);
  }

  const merged = [...byEmail.values()].sort((a, b) =>
    String(a.at || '').localeCompare(String(b.at || '')),
  );
  fs.writeFileSync(full, JSON.stringify(merged, null, 2), 'utf8');
  return full;
}
