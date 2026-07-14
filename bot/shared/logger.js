import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, summary: 20, warn: 30, error: 40 };

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  summary: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
  tag: '\x1b[35m',
};

function ts() {
  return new Date().toISOString().slice(11, 23);
}

/** Resumo compacto por conta (modo SIMPLE_LOGS). */
export function formatAccountSummary(result) {
  const email = result?.email ?? '?';
  const login =
    result?.ok === true ? 'OK' : result?.ok === false ? 'FALHA' : '-';

  let trial = '-';
  if (result?.trialDetected === true) trial = 'sim';
  else if (result?.trialDetected === false) trial = 'nao';

  let pix = '-';
  if (config.subscribeTrial) {
    if (result?.pixSubscribed === true) pix = 'OK';
    else if (result?.pixSubscribed === false) pix = 'FALHA';
    else if (result?.ok && result?.trialDetected === false) pix = 'pulado';
  }

  return `${email} | login: ${login} | trial: ${trial} | pix: ${pix}`;
}

/**
 * Cria um logger com um prefixo (tag) por instancia.
 * Com SIMPLE_LOGS=true, info/debug/warn ficam silenciados (erros e summary continuam).
 */
export function createLogger(tag = '') {
  const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
  const prefix = tag ? `${COLORS.tag}[${tag}]${COLORS.reset} ` : '';

  function emit(level, args, { force = false } = {}) {
    if (!force && config.simpleLogs && level !== 'error' && level !== 'summary') return;
    if (LEVELS[level] < threshold && level !== 'summary') return;

    const color = COLORS[level] || COLORS.info;
    const label = level === 'summary' ? 'RESUM' : level.toUpperCase().padEnd(5);
    const line = `${COLORS.reset}${ts()} ${color}${label}${COLORS.reset} ${prefix}`;
    const stream = level === 'error' || level === 'warn' ? console.error : console.log;
    stream(line, ...args);
  }

  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    summary: (...a) => emit('summary', a, { force: true }),
    child: (subTag) => createLogger(tag ? `${tag} ${subTag}` : subTag),
  };
}

export const logger = createLogger();
