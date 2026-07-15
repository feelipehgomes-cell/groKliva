import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveRootDir() {
  if (process.env.KLIVA_ROOT) {
    return path.resolve(process.env.KLIVA_ROOT);
  }
  const __filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(__filename), '../..');
}

export const ROOT_DIR = resolveRootDir();

const ENV_PATH = path.join(ROOT_DIR, '.env');
// Nunca sobrescrever process.env: o botManager injeta RESULTS_FILE/WHATSAPP_* por grupo.
dotenv.config({ path: ENV_PATH, override: false });

function resolveDataPath(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/');
  const rootPath = path.join(ROOT_DIR, normalized);
  if (fs.existsSync(rootPath)) return normalized;

  // Caminhos aninhados (ex.: data/groups/slug/results.json) nao devem colapsar
  // para data/<basename> quando o arquivo ainda nao existe.
  const dir = path.posix.dirname(normalized);
  if (dir !== '.' && dir !== 'data') {
    return normalized.startsWith('data/') ? normalized : `data/${normalized}`;
  }

  const base = path.basename(normalized);
  const dataRel = path.join('data', base).replace(/\\/g, '/');
  const dataPath = path.join(ROOT_DIR, dataRel);
  if (fs.existsSync(dataPath)) return dataRel;
  return normalized.startsWith('data/') ? normalized : dataRel;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(
    String(value).trim().toLowerCase(),
  );
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function buildDefaultLoginUrl() {
  if (process.env.GROK_LOGIN_URL) return process.env.GROK_LOGIN_URL.trim();
  const redirect = (process.env.GROK_LOGIN_REDIRECT || 'grok-com').trim();
  return `https://accounts.x.ai/sign-in?redirect=${encodeURIComponent(redirect)}`;
}

function buildEmailLoginUrl(loginUrl) {
  if (process.env.GROK_EMAIL_LOGIN_URL) return process.env.GROK_EMAIL_LOGIN_URL.trim();
  const url = loginUrl || buildDefaultLoginUrl();
  try {
    const u = new URL(url);
    u.searchParams.set('email', 'true');
    return u.href;
  } catch {
    if (/[?&]email=true/i.test(url)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}email=true`;
  }
}

/** URL de login com email da conta (abre formulario direto no x.ai). */
export function buildAccountEmailLoginUrl(email, loginUrl) {
  const base = loginUrl || buildDefaultLoginUrl();
  const addr = String(email || '').trim();
  try {
    const u = new URL(base);
    u.searchParams.set('email', addr || 'true');
    return u.href;
  } catch {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}email=${encodeURIComponent(addr || 'true')}`;
  }
}

/** Remove comentario inline apos espaco+# (ex: "id@g.us # grupo teste"). */
function stripInlineEnvComment(value) {
  const s = String(value ?? '').trim();
  const hash = s.indexOf(' #');
  return hash >= 0 ? s.slice(0, hash).trim() : s;
}

function looksLikeProxyUrl(value) {
  const v = String(value || '').trim();
  return v.includes('@') && /:[0-9]{2,5}$/.test(v.split('@').pop() || '');
}

/** PROXY_URL vazia mas URL inteira em PROXY_SESSION_TEMPLATE (erro comum). */
function resolveProxyUrl() {
  const direct = (process.env.PROXY_URL || '').trim();
  if (direct) return direct;
  const template = (process.env.PROXY_SESSION_TEMPLATE || '').trim();
  if (looksLikeProxyUrl(template)) return template;
  return '';
}

function resolveProxySessionTemplate() {
  const tpl = (process.env.PROXY_SESSION_TEMPLATE || '{user}-session-{session}').trim();
  if (looksLikeProxyUrl(tpl)) return '{user}-session-{session}';
  return tpl || '{user}-session-{session}';
}

// rebrowser (usado internamente pelo puppeteer-real-browser)
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE =
  process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE || 'addBinding';

export const config = {
  headless: bool(process.env.HEADLESS, false),
  keepBrowserOpen: bool(process.env.KEEP_BROWSER_OPEN, false),
  hideWindows: bool(process.env.HIDE_WINDOWS, false),

  chromePath: process.env.CHROME_PATH || '',
  chromeFreshProfile: bool(process.env.CHROME_FRESH_PROFILE, true),
  killStaleChromeOnStart: bool(process.env.KILL_STALE_CHROME_ON_START, true),
  chromeProfilesDir: process.env.CHROME_PROFILES_DIR || '.chrome-profiles',
  /** Timeout do protocolo CDP (Network.enable etc). Maquinas lentas/OneDrive precisam mais. */
  protocolTimeoutMs: int(process.env.PROTOCOL_TIMEOUT_MS, 180000),
  locale: process.env.LOCALE || 'pt-BR',
  timezone: process.env.TIMEZONE || 'America/Sao_Paulo',
  acceptLanguage:
    process.env.ACCEPT_LANGUAGE || 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',

  concurrency: int(process.env.CONCURRENCY, 1),
  instanceStaggerMs: int(process.env.INSTANCE_STAGGER_MS, 800),
  maxRetriesPerAccount: int(process.env.MAX_RETRIES_PER_ACCOUNT, 1),
  /** 0 = sem limite. Encerra conta presa (login/subscribe/pagamento). */
  accountTimeoutMs: int(process.env.ACCOUNT_TIMEOUT_MS, 0),

  proxyUrl: resolveProxyUrl(),
  proxySticky: bool(process.env.PROXY_STICKY, true),
  proxySessionTemplate: resolveProxySessionTemplate(),
  proxyVerifyTimeoutMs: int(process.env.PROXY_VERIFY_TIMEOUT_MS, 45000),
  proxyVerifyRetries: int(process.env.PROXY_VERIFY_RETRIES, 2),
  proxyVerifyOnStart: bool(process.env.PROXY_VERIFY_ON_START, false),
  /** Limite de instancias com proxy residencial (evita saturar tunel). 0 = sem limite. */
  proxyMaxConcurrency: int(process.env.PROXY_MAX_CONCURRENCY, 10),
  proxyNavTimeoutMs: int(process.env.PROXY_NAV_TIMEOUT_MS, 45000),
  proxyLoginPostSubmitMs: int(process.env.PROXY_LOGIN_POST_SUBMIT_MS, 75000),
  proxyLoginPollMs: int(process.env.PROXY_LOGIN_POLL_MS, 100),
  proxyLoginSelectorTimeoutMs: int(process.env.PROXY_LOGIN_SELECTOR_TIMEOUT_MS, 10000),
  proxyTrialCheckMs: int(process.env.PROXY_TRIAL_CHECK_MS, 8000),
  proxyInstanceStaggerMs: int(process.env.PROXY_INSTANCE_STAGGER_MS, 1500),
  proxyBlockHeavyResources: bool(process.env.PROXY_BLOCK_HEAVY_RESOURCES, true),
  /** Com proxy: bloqueia CSS fora de auth/Stripe/Cloudflare (agressivo — teste antes). */
  proxyBlockStylesheets: bool(process.env.PROXY_BLOCK_STYLESHEETS, false),
  /** Com proxy: reutiliza perfil Chrome por conta (retry mais rapido). */
  proxyKeepProfile: bool(process.env.PROXY_KEEP_PROFILE, true),
  // Liga/desliga a proxy por bot (independente). CLI --proxy / --no-proxy sobrescreve.
  loginUseProxy: bool(process.env.LOGIN_USE_PROXY ?? process.env.PIX_USE_PROXY, true),

  loginUrl: buildDefaultLoginUrl(),
  emailLoginUrl: buildEmailLoginUrl(process.env.GROK_LOGIN_URL || buildDefaultLoginUrl()),
  postLoginUrl: process.env.GROK_POST_LOGIN_URL || 'https://grok.com',
  subscribePageUrl:
    process.env.GROK_SUBSCRIBE_URL ||
    `${(process.env.GROK_POST_LOGIN_URL || 'https://grok.com').replace(/\/$/, '')}/#subscribe`,
  loggedInUrlHint: process.env.GROK_LOGGED_IN_URL_HINT || 'grok.com',
  trialCheckUrls: (process.env.TRIAL_CHECK_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),

  subscribeTrial: bool(process.env.SUBSCRIBE_TRIAL, false),

  /**
   * Envia contas prontas do PIX no grupo ao finalizar/parar o ativador.
   * Aceita a chave antiga WHATSAPP_SEND_GENERATED_ON_STOP como fallback.
   */
  whatsappSendReadyPixOnStop: bool(
    process.env.WHATSAPP_SEND_READY_PIX_ON_STOP ??
      process.env.WHATSAPP_SEND_GENERATED_ON_STOP,
    false,
  ),

  pixPayerName: (process.env.PIX_PAYER_NAME || '').trim(),
  pixPayerCpf: (process.env.PIX_PAYER_CPF || '').trim(),
  /** Arquivo com linhas cpf|nome. 1 pagador = N contas (PAYER_ACCOUNTS_PER_RESULT). */
  payerResultsFile: resolveDataPath(process.env.PAYER_RESULTS_FILE || 'payer-results.txt').trim(),
  payerResultsStateFile: resolveDataPath(process.env.PAYER_RESULTS_STATE_FILE || 'payer-results-state.json').trim(),
  payerAccountsPerResult: int(process.env.PAYER_ACCOUNTS_PER_RESULT, 10),
  pixWaitMs: int(process.env.PIX_WAIT_MS, 30000),
  pixGenerateWaitMs: int(process.env.PIX_GENERATE_WAIT_MS, 60000),
  pixManualReveal: bool(process.env.PIX_MANUAL_REVEAL, false),
  /**
   * true = libera o slot apos enviar PIX (NAO confirma pagamento).
   * Ignorado: o bot sempre aguarda pagamento confirmado.
   */
  releaseBrowserAfterPixSend: false,
  /** Ms de checagem rapida de pagamento antes de fechar o browser (so modo rapido). */
  pixPostSendCheckMs: int(process.env.PIX_POST_SEND_CHECK_MS, 45000),
  /** Sempre true: contas prontas exigem pagamento confirmado no Stripe. */
  waitForPixPayment: true,
  /** Ms maximo aguardando pagamento no modo hold (nao usado com waitForPixPayment). */
  pixBrowserHoldMs: int(process.env.PIX_BROWSER_HOLD_MS, 180000),
  /** 0 = infinito ate pagar; 1 = um ciclo e libera browser. */
  paymentWaitMaxCycles: int(process.env.PAYMENT_WAIT_MAX_CYCLES, 0),
  /** 0 = auto (escala com CONCURRENCY). Ms para aguardar Stripe apos CTA trial. */
  stripeCheckoutWaitMs: int(process.env.STRIPE_CHECKOUT_WAIT_MS, 0),
  /** 0 = auto. Ms tentando clicar opcao PIX no Stripe. */
  stripePixSelectMs: int(process.env.STRIPE_PIX_SELECT_MS, 0),
  /** 0 = auto. Ms na tela de planos trial (pre-Stripe) clicando card/continuar. */
  trialPlanAdvanceMs: int(process.env.TRIAL_PLAN_ADVANCE_MS, 0),
  /** 0 = sem limite fixo (usa TRIAL_PLAN_ADVANCE_MS / tempo total). Pausa entre cliques no plano trial. */
  subscribeErrorMaxRetries: int(process.env.SUBSCRIBE_ERROR_MAX_RETRIES, 0),
  /** Ms entre tentativas de clicar "Solicitar oferta" quando Grok mostra erro. */
  subscribeErrorRetryMs: int(process.env.SUBSCRIBE_ERROR_RETRY_MS, 6000),
  paymentWaitCycleMs: int(process.env.PAYMENT_WAIT_CYCLE_MS, 300000),
  /** Segundos seguidos sem QR (apos ja ter visto) para confirmar por sumico. 0 = desligado. */
  paymentGoneStreakSec: int(process.env.PAYMENT_GONE_STREAK_SEC, 0),
  paidCountFile: resolveDataPath(process.env.PAID_COUNT_FILE || 'paid-count.txt'),
  paidEmailsFile: resolveDataPath(process.env.PAID_EMAILS_FILE || 'paid-emails.txt'),
  skipPaidAccounts: bool(process.env.SKIP_PAID_ACCOUNTS, true),
  /** 0 = processar todas as contas. Limite padrao do ativador PIX. */
  activateAccountLimit: int(process.env.ACTIVATE_ACCOUNT_LIMIT, 0),

  whatsappEnabled: bool(process.env.WHATSAPP_ENABLED, true),
  whatsappProvider: (process.env.WHATSAPP_PROVIDER || 'baileys')
    .trim()
    .toLowerCase(),
  whatsappFailSoft: bool(process.env.WHATSAPP_FAIL_SOFT, true),
  /** Retentativas de envio Baileys apos queda de conexao (VPN, rede). */
  whatsappSendRetries: int(process.env.WHATSAPP_SEND_RETRIES, 3),
  whatsappAuthDir: process.env.WHATSAPP_AUTH_DIR || 'whatsapp-auth',
  whatsappPhoneNumber: (process.env.WHATSAPP_PHONE_NUMBER || '').trim(),
  evolutionApiUrl: (process.env.EVOLUTION_API_URL || '').trim(),
  evolutionApiKey: (process.env.EVOLUTION_API_KEY || '').trim(),
  evolutionInstance: (process.env.EVOLUTION_INSTANCE || '').trim(),
  whatsappGroupId: stripInlineEnvComment(process.env.WHATSAPP_GROUP_ID || ''),
  whatsappGroupName: (process.env.WHATSAPP_GROUP_NAME || '').trim(),
  whatsappWebhookUrl: (process.env.WHATSAPP_WEBHOOK_URL || '').trim(),
  whatsappCommandsEnabled: bool(process.env.WHATSAPP_COMMANDS_ENABLED, true),
  whatsappCommandsPublic: bool(process.env.WHATSAPP_COMMANDS_PUBLIC, true),
  whatsappAdminPhones: (process.env.WHATSAPP_ADMIN_PHONES || '').trim(),
  /** true = entrega de mensagens em tempo real no hub (recomendado para /start). */
  whatsappMarkOnlineOnConnect: bool(process.env.WHATSAPP_MARK_ONLINE_ON_CONNECT, false),
  klivaPort: int(process.env.KLIVA_PORT, 4000),
  klivaGroupId: (process.env.KLIVA_GROUP_ID || process.env.WHATSAPP_GROUP_ID || '').trim(),
  klivaGroupSlug: (process.env.KLIVA_GROUP_SLUG || '').trim(),

  selectors: {
    emailInput:
      process.env.SEL_EMAIL ||
      'input[type="email"], input[name="email"], input[autocomplete="username"], input[inputmode="email"]',
    emailSubmit: process.env.SEL_EMAIL_SUBMIT || 'button[type="submit"]',
    passwordInput:
      process.env.SEL_PASSWORD ||
      'input[type="password"], input[name="password"], input[autocomplete="current-password"]',
    passwordSubmit: process.env.SEL_PASSWORD_SUBMIT || 'button[type="submit"]',
    turnstileWidget:
      process.env.SEL_TURNSTILE ||
      '.cf-turnstile, [data-sitekey], iframe[src*="challenges.cloudflare.com"]',

    trialCta: process.env.SEL_TRIAL_CTA || '',
    trialCard:
      process.env.SEL_TRIAL_CARD ||
      '[data-testid="plan-cta-supergrok"], button[data-testid="plan-cta-supergrok"]',
    paymentPix:
      process.env.SEL_PAYMENT_PIX ||
      '[data-testid="pix-accordion-item-button"]',
    revealQr:
      process.env.SEL_REVEAL_QR ||
      '[data-testid="hosted-payment-submit-button"]',
    payerNameInput:
      process.env.SEL_PAYER_NAME ||
      'input[name="name"], input[autocomplete="name"], input[placeholder*="Nome completo" i], input[aria-label*="Nome completo" i], input[placeholder*="pagador" i], input[aria-label*="pagador" i]',
    payerCpfInput:
      process.env.SEL_PAYER_CPF ||
      '#taxId, input[name="taxId"], input[autocomplete="tax-id"], input[placeholder="000.000.000-00"], input[placeholder*="CPF" i], input[name*="cpf" i]',
    subscribeSubmit: process.env.SEL_SUBSCRIBE_SUBMIT || '',
    pixCopyCode:
      process.env.SEL_PIX_COPY ||
      '[class*="QrDataText"] span, input[readonly], textarea[readonly], input[value*="000201"]',
    pixQrImage:
      process.env.SEL_PIX_QR ||
      'img[data-testid="QRCode-image"], img[src*="qr.stripe.com"], canvas, img[alt*="QR" i]',
  },

  defaultTimeout: int(process.env.DEFAULT_TIMEOUT, 45000),
  navTimeout: int(process.env.NAV_TIMEOUT, 30000),
  pollMs: int(process.env.POLL_MS, 100),
  loginPollMs: int(process.env.LOGIN_POLL_MS, 250),
  /** Tempo max aguardando redirect apos clicar Entrar (proxy residencial e lenta). */
  loginPostSubmitMs: int(process.env.LOGIN_POST_SUBMIT_MS, 60000),
  trialCheckMs: int(process.env.TRIAL_CHECK_MS, 15000),

  accountsFile: resolveDataPath(process.env.ACCOUNTS_FILE || 'accounts.txt'),
  resultsFile: resolveDataPath(process.env.RESULTS_FILE || 'results.json'),

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  /** true = so resumo por conta (login / trial / pix) + erros */
  simpleLogs: bool(process.env.SIMPLE_LOGS, false),
  screenshotOnError: bool(process.env.SCREENSHOT_ON_ERROR, true),
  screenshotDir: process.env.SCREENSHOT_DIR || 'screenshots',
};

// chrome-launcher trata process.env.HEADLESS como truthy mesmo quando "false" (string)
delete process.env.HEADLESS;

/** Le CONCURRENCY direto do .env (valor atual no disco). */
export function readConcurrencyFromEnv() {
  try {
    if (!fs.existsSync(ENV_PATH)) return config.concurrency;
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    const m = raw.match(/^CONCURRENCY=(\d+)/m);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1) return n;
    }
  } catch {
    /* noop */
  }
  return config.concurrency;
}

/** Le ACTIVATE_ACCOUNT_LIMIT direto do .env (0 = todas). */
export function readActivateLimitFromEnv() {
  try {
    if (!fs.existsSync(ENV_PATH)) return config.activateAccountLimit;
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    const m = raw.match(/^ACTIVATE_ACCOUNT_LIMIT=(\d+)/m);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch {
    /* noop */
  }
  return config.activateAccountLimit;
}

export function assertConfig() {
  const errors = [];
  if (config.concurrency < 1) errors.push('CONCURRENCY deve ser >= 1.');
  if (config.subscribeTrial) {
    const usePayerFile = !!config.payerResultsFile;
    if (!usePayerFile) {
      if (!config.pixPayerName)
        errors.push('SUBSCRIBE_TRIAL=true exige PIX_PAYER_NAME ou PAYER_RESULTS_FILE.');
      if (!config.pixPayerCpf)
        errors.push('SUBSCRIBE_TRIAL=true exige PIX_PAYER_CPF ou PAYER_RESULTS_FILE.');
    }
  }
  if (errors.length) {
    throw new Error('Config invalida:\n - ' + errors.join('\n - '));
  }
}
