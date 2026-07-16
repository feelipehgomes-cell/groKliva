import fs from 'node:fs';

import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

import { config, ROOT_DIR } from '../config.js';
import { effectiveNavTimeout, isProxyActive } from '../proxy/proxy.js';

function resolveChromeExecutable() {

  if (config.chromePath && fs.existsSync(config.chromePath)) return config.chromePath;



  const candidates =

    process.platform === 'win32'

      ? [

          `${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`,

          `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,

          `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,

        ]

      : process.platform === 'darwin'

        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']

        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];



  for (const c of candidates) {

    try {

      if (c && fs.existsSync(c)) return c;

    } catch {

      /* noop */

    }

  }

  return null;

}



export function resolveProfilesRoot(profilesDir) {
  const dir = profilesDir ?? config.chromeProfilesDir;
  return path.isAbsolute(dir) ? dir : path.join(ROOT_DIR, dir);
}

function profilesRoot() {
  return resolveProfilesRoot();
}

function buildProfileNeedles(rootDir) {
  const norm = path.normalize(rootDir);
  const needles = new Set();
  const add = (value) => {
    const s = String(value || '').trim();
    if (s.length >= 8) needles.add(s);
  };

  add(norm);
  add(norm.replace(/\\/g, '/'));

  const rel = path.relative(ROOT_DIR, norm);
  if (rel && !rel.startsWith('..')) {
    add(rel);
    add(rel.replace(/\\/g, '/'));
  }

  return [...needles];
}

/** Encerra Chrome de runs anteriores no diretorio de perfis indicado. */
export function killStaleChromeFromProfiles(log, { force = false, profilesDir = null } = {}) {
  if (!force && !config.killStaleChromeOnStart) return 0;

  const root = resolveProfilesRoot(profilesDir);
  const needles = buildProfileNeedles(root);
  if (!needles.length) return 0;

  let killed = 0;

  try {
    if (process.platform === 'win32') {
      const escaped = needles.map((n) => n.replace(/'/g, "''"));
      const matchExpr = escaped
        .map((n) => `$_.CommandLine.Contains('${n}')`)
        .join(' -or ');
      const script = [
        '$n = 0',
        `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -and (${matchExpr}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }`,
        'Write-Output $n',
      ].join('; ');
      const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
      });
      const out = (result.stdout || '').trim().split(/\r?\n/).pop() || '0';
      killed = parseInt(out, 10) || 0;
    } else {
      for (const needle of needles) {
        execSync(`pkill -f "${needle.replace(/"/g, '\\"')}" 2>/dev/null || true`, {
          stdio: 'ignore',
          timeout: 10000,
        });
      }
    }
  } catch (e) {
    log?.warn?.('killStaleChrome:', e.message);
    return 0;
  }

  if (killed > 0) {
    log?.info?.(`Encerrado(s) ${killed} Chrome(s) antigo(s) em ${path.relative(ROOT_DIR, root) || root}.`);
  }
  return killed;
}

/** Remove sessao/cache sem apagar o diretorio inteiro (mais rapido que rmSync no Windows). */
function wipeChromeProfileDir(userDataDir, log) {
  if (!fs.existsSync(userDataDir)) return;
  killStaleChromeFromProfiles(log, { force: true, profilesDir: userDataDir });
  const targets = [
    'Default',
    'SingletonLock',
    'SingletonCookie',
    'lockfile',
    'GrShaderCache',
    'ShaderCache',
    'GraphiteDawnCache',
    'BrowserMetrics',
    'BrowserMetrics-spare.pma',
  ];
  for (const name of targets) {
    try {
      fs.rmSync(path.join(userDataDir, name), { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  log?.debug?.(`perfil resetado: ${path.basename(userDataDir)}`);
}

const AUTH_ORIGINS = ['https://accounts.x.ai', 'https://x.ai', 'https://grok.com', 'https://www.grok.com'];



function safeProfileKey(profileKey) {
  return String(profileKey || `run-${Date.now()}`)
    .replace(/[^a-z0-9@._-]/gi, '_')
    .slice(0, 100);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJsonSafe(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

/** Slot do worker (S1.2 -> 1) para posicionar janelas sem sobrepor. */
export function parseWindowSlot(workerId) {
  const m = String(workerId || '').match(/^S(\d+)/i);
  const n = m ? parseInt(m[1], 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

let cachedWorkArea = null;

/** Area util da tela primaria (sem barra de tarefas). */
function getScreenWorkArea() {
  if (cachedWorkArea) return cachedWorkArea;
  const fallback = { width: 1920, height: 1040 };
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $w=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; Write-Output ($w.Width.ToString() + \' \' + $w.Height.ToString())"',
        { encoding: 'utf8', timeout: 5000, windowsHide: true },
      ).trim();
      const [w, h] = out.split(/\s+/).map((n) => parseInt(n, 10));
      if (w > 400 && h > 300) {
        cachedWorkArea = { width: w, height: h };
        return cachedWorkArea;
      }
    }
  } catch {
    /* fallback */
  }
  cachedWorkArea = fallback;
  return cachedWorkArea;
}

/** Grade que cabe N instancias na tela (prioriza colunas em monitores largos). */
function pickGrid(count, screenW, screenH) {
  const n = Math.max(1, count);
  let best = { cols: n, rows: 1, score: Infinity };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = screenW / cols;
    const th = screenH / rows;
    const aspect = tw / Math.max(1, th);
    const unused = cols * rows - n;
    // Prefer aspecto ~1.35 (janela util) e poucas celulas vazias
    const score = Math.abs(aspect - 1.35) + unused * 0.25 + rows * 0.05;
    if (score < best.score) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows };
}

/**
 * Tamanho + posicao da janela do slot para caber CONCURRENCY instancias na tela.
 * Retorna { x, y, width, height }.
 */
function getWindowLayout(slot) {
  const screen = getScreenWorkArea();
  const n = Math.max(1, Number(config.concurrency) || 1);
  const gap = 6;
  const { cols, rows } = pickGrid(n, screen.width, screen.height);
  const width = Math.max(420, Math.floor((screen.width - gap * (cols + 1)) / cols));
  const height = Math.max(320, Math.floor((screen.height - gap * (rows + 1)) / rows));
  const idx = Math.max(0, (slot || 1) - 1);
  const col = idx % cols;
  const row = Math.floor(idx / cols);
  return {
    x: gap + col * (width + gap),
    y: gap + row * (height + gap),
    width,
    height,
    cols,
    rows,
  };
}

/** Garante bounds apos o Chrome abrir (perfil pode ignorar --window-size). */
async function applyWindowBounds(browser, page, layout, log) {
  if (!page || !layout) return;
  try {
    const client =
      page.__cdp || (await page.target().createCDPSession());
    page.__cdp = client;
    const { windowId } = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
        windowState: 'normal',
      },
    });
  } catch (e) {
    log?.debug?.(`setWindowBounds falhou: ${e.message}`);
  }
}

/** Traz pagina/aba para frente (evita falha de captcha/clique em janela minimizada). */
export async function focusPage(page, log) {
  if (!page) return page;
  try {
    await page.bringToFront();
  } catch (e) {
    log?.debug?.('bringToFront falhou:', e.message);
  }
  return page;
}



/** Perfil isolado por conta/tentativa (evita reutilizar sessao de outra conta). */

export function getChromeProfileDir(profileKey) {

  return path.join(profilesRoot(), safeProfileKey(profileKey));

}



/** Perfil Chrome sem gerenciador de senhas (evita popup "Salvar senha?"). */

function ensureChromeProfile(dir) {
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  const prefsPath = path.join(dir, 'Default', 'Preferences');
  const localStatePath = path.join(dir, 'Local State');
  const prefs = readJsonSafe(prefsPath);
  const localState = readJsonSafe(localStatePath);

  prefs.credentials_enable_service = false;
  prefs.profile = { ...(prefs.profile || {}), password_manager_enabled: false };
  // Google Translate desligado no perfil (a flag sozinha nao basta em todo Chrome).
  prefs.translate = { enabled: false };
  prefs.translate_blocked_languages = ['en', 'pt'];
  prefs.exit_type = 'Normal';
  prefs.exited_cleanly = true;
  localState.profile = {
    ...(localState.profile || {}),
    exit_type: 'Normal',
    exited_cleanly: true,
  };

  writeJsonSafe(prefsPath, prefs);
  writeJsonSafe(localStatePath, localState);

}



export async function launchBrowser({ proxy, log, profileKey, windowSlot = 1 } = {}) {
  const { connect } = await import('puppeteer-real-browser');

  const exe = resolveChromeExecutable();



  const proxyOpt =

    proxy && proxy.host

      ? { host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password }

      : undefined;



  const userDataDir = getChromeProfileDir(profileKey);

  let profileWasFresh = false;
  if (config.chromeFreshProfile) {
    const wipe = !(proxy && config.proxyKeepProfile);
    profileWasFresh = wipe;
    if (wipe) {
      wipeChromeProfileDir(userDataDir, log);
    }
  }



  ensureChromeProfile(userDataDir);



  const args = [
    `--lang=${config.locale}`,
    '--window-size=1280,800',
    // UM unico --disable-features: o Chrome ignora flags repetidas (so a ultima vale).
    // Translate + TranslateUI matam o popup "Traduzir esta pagina?" que cobria o CTA.
    '--disable-features=Translate,TranslateUI,CrashRestoreBubble,CrashRestoreUI,PasswordManager,PasswordCheck,PasswordLeakDetection,AutofillServerCommunication',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-translate',
    // Stripe abre via window.open — sem isso, clique sintetico e bloqueado como popup.
    '--disable-popup-blocking',
    // Esconde a infobar "linha de comando nao suportada: --no-sandbox".
    '--test-type',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--metrics-recording-only',
    '--mute-audio',
  ];

  let windowLayout = null;
  if (config.hideWindows && !config.headless) {
    args.push('--window-position=-2400,-2400');
  } else if (!config.headless) {
    windowLayout = getWindowLayout(windowSlot);
    // Substitui o --window-size fixo por tamanho da grade
    const sizeIdx = args.findIndex((a) => a.startsWith('--window-size='));
    if (sizeIdx >= 0) {
      args[sizeIdx] = `--window-size=${windowLayout.width},${windowLayout.height}`;
    } else {
      args.push(`--window-size=${windowLayout.width},${windowLayout.height}`);
    }
    args.push(`--window-position=${windowLayout.x},${windowLayout.y}`);
    log?.debug?.(
      `janela slot ${windowSlot}: ${windowLayout.width}x${windowLayout.height} @ ${windowLayout.x},${windowLayout.y} (grade ${windowLayout.cols}x${windowLayout.rows})`,
    );
  }



  let browser;
  let page;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      ({ browser, page } = await connect({
        headless: config.headless ? 'new' : false,
        // NAO usar turnstile:true — roda checkTurnstile a cada 1s em TODA pagina e rouba foco no Stripe.
        // Usamos startBackgroundTurnstileSolver() so durante login (turnstile.js).
        turnstile: false,
        args,
        customConfig: {
          ...(exe ? { chromePath: exe } : {}),
          userDataDir,
        },
        proxy: proxyOpt,
        connectOption: {
          defaultViewport: null,
          protocolTimeout: config.protocolTimeoutMs,
        },
      }));
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        log?.warn?.(`Falha ao abrir Chrome (tentativa ${attempt}/2): ${err.message}`);
        killStaleChromeFromProfiles(log, { force: true, profilesDir: userDataDir });
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }
  if (lastErr) throw lastErr;

  log?.debug?.(`puppeteer-real-browser conectado (perfil: ${path.basename(userDataDir)})`);

  browser.__userDataDir = userDataDir;
  browser.__freshProfile = config.chromeFreshProfile;
  browser.__profileWasFresh = profileWasFresh;
  browser.__realPage = page;
  browser.__windowLayout = windowLayout;
  attachChromePid(browser, log);

  if (windowLayout && !config.headless && !config.hideWindows) {
    await applyWindowBounds(browser, page, windowLayout, log);
  }

  return browser;
}



export async function setupPage(browser, { proxy, log, prefetchUrl } = {}) {

  const page = browser.__realPage;

  if (!page) throw new Error('Pagina nao inicializada pelo puppeteer-real-browser.');



  page.setDefaultTimeout(config.defaultTimeout);

  page.setDefaultNavigationTimeout(effectiveNavTimeout());



  try {

    page.__userAgent = await page.evaluate(() => navigator.userAgent);

  } catch {

    /* noop */

  }



  await page.setExtraHTTPHeaders({ 'Accept-Language': config.acceptLanguage }).catch(() => {});

  await enableProxyBandwidthSaver(page, log);

  try {

    const client = await page.target().createCDPSession();

    page.__cdp = client;

    // setFocusEmulationEnabled rouba foco dos inputs quando o usuario clica manualmente.

    if (config.timezone) await client.send('Emulation.setTimezoneOverride', { timezoneId: config.timezone }).catch(() => {});

    if (config.locale) await client.send('Emulation.setLocaleOverride', { locale: config.locale }).catch(() => {});

    if (browser.__windowLayout && !config.headless && !config.hideWindows) {
      await applyWindowBounds(browser, page, browser.__windowLayout, log);
    }

  } catch (e) {

    log?.debug?.('emulacao locale/timezone falhou:', e.message);

  }



  if (proxy && proxy.username) {

    await page.authenticate({ username: proxy.username, password: proxy.password }).catch(() => {});

  }

  if (prefetchUrl) {
    try {
      await page.goto(prefetchUrl, { waitUntil: 'domcontentloaded', timeout: effectiveNavTimeout() });
      page.__prefetchedLoginUrl = prefetchUrl;
      log?.debug?.(`prefetch login concluido: ${prefetchUrl}`);
    } catch (e) {
      log?.debug?.('prefetch login falhou (loginGrok repete):', e.message);
    }
  }



  return page;

}

/** URLs que precisam de imagens/fontes (Turnstile, login, QR PIX no Stripe). */
function proxyAllowHeavyResource(url = '') {
  return (
    /challenges\.cloudflare\.com|turnstile|cloudflare\.com\/cdn-cgi/i.test(url) ||
    /accounts\.x\.ai|\.x\.ai/i.test(url) ||
    /checkout\.stripe\.com|js\.stripe\.com|stripe\.network/i.test(url)
  );
}

const PROXY_TRACKER_RE =
  /google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.(io|com)|sentry\.io|amplitude|fullstory|intercom|mixpanel|clarity\.ms|optimizely|googlesyndication|adservice\.google/i;

const PROXY_HEAVY_TYPES = new Set(['image', 'font', 'media', 'websocket', 'manifest']);

/** Bloqueia recursos pesados/telemetria fora de auth/Stripe (so com proxy ativa). */
async function enableProxyBandwidthSaver(page, log) {
  if (!isProxyActive() || !config.proxyBlockHeavyResources || page.__bandwidthSaver) return;
  page.__bandwidthSaver = true;
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();
      if (proxyAllowHeavyResource(url)) {
        req.continue();
        return;
      }
      if (PROXY_HEAVY_TYPES.has(type)) {
        req.abort();
        return;
      }
      if (
        config.proxyBlockStylesheets &&
        type === 'stylesheet' &&
        !/accounts\.x\.ai|checkout\.stripe|challenges\.cloudflare/i.test(url)
      ) {
        req.abort();
        return;
      }
      if (PROXY_TRACKER_RE.test(url)) {
        req.abort();
        return;
      }
      if (/favicon\.ico|apple-touch-icon|android-chrome/i.test(url)) {
        req.abort();
        return;
      }
      req.continue();
    });
    log?.debug?.('bandwidth saver ativo (proxy — auth/Stripe/Cloudflare liberados).');
  } catch (e) {
    log?.debug?.('bandwidth saver falhou:', e.message);
  }
}



/** Limpa cookies/cache/storage das origens de auth (logout forcado). */
export async function clearAuthStorage(page, log) {
  try {
    const client = page.__cdp || (await page.target().createCDPSession());
    await client.send('Network.clearBrowserCookies');
    await client.send('Network.clearBrowserCache');
    for (const origin of AUTH_ORIGINS) {
      await client
        .send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
        .catch(() => {});
    }
    log?.debug?.('Storage de auth limpo.');
  } catch (e) {
    log?.debug?.('clearAuthStorage falhou:', e.message);
  }
}

/** Desloga sessao antiga antes de logar outra conta. */
export async function ensureLoggedOut(page, log) {
  try {
    await page.goto('https://accounts.x.ai/sign-out?redirect=grok-com', {
      waitUntil: 'domcontentloaded',
      timeout: effectiveNavTimeout(),
    });
    await new Promise((r) => setTimeout(r, 150));
  } catch {
    /* noop */
  }
  await clearAuthStorage(page, log);
}

/** Limpa cookies/cache para garantir login do zero. */

export async function clearBrowserSession(page, log) {

  if (!config.chromeFreshProfile) return;

  try {

    const client = page.__cdp || (await page.target().createCDPSession());

    await client.send('Network.clearBrowserCookies');

    await client.send('Network.clearBrowserCache');

    log?.debug?.('Sessao do browser limpa (cookies/cache).');

  } catch (e) {

    log?.debug?.('limpeza de sessao falhou:', e.message);

  }

}



/** Prefere aba do Stripe checkout (QR PIX fica la). */

export async function resolveStripeCheckoutPage(browser, page, log) {

  const usable = async (p) => {

    if (!p || (typeof p.isClosed === 'function' && p.isClosed())) return false;

    try {

      await p.evaluate(() => true);

      return true;

    } catch {

      return false;

    }

  };



  try {

    const pages = await browser.pages();

    for (let i = pages.length - 1; i >= 0; i--) {

      const p = pages[i];

      if (!(await usable(p))) continue;

      const url = p.url();

      if (/checkout\.stripe\.com|stripe\.com\/(?:c\/)?pay|stripe\.com\/g\/pay/i.test(url)) {
        log?.debug?.('Aba Stripe checkout encontrada.');
        browser.__realPage = p;
        return focusPage(p, log);
      }

      if (/stripe\.com|buy\.stripe/i.test(url)) {
        log?.debug?.('Aba Stripe (hosted) encontrada.');
        browser.__realPage = p;
        return focusPage(p, log);
      }

    }

  } catch (e) {

    log?.debug?.('falha ao buscar aba stripe:', e.message);

  }



  return resolveActivePage(browser, page, log);

}



/** Reanexa a pagina ativa apos navegacao/submit do Stripe (evita frame detached). */

export async function resolveActivePage(browser, page, log) {

  const usable = async (p) => {

    if (!p || (typeof p.isClosed === 'function' && p.isClosed())) return false;

    try {

      await p.evaluate(() => true);

      return true;

    } catch {

      return false;

    }

  };



  if (await usable(page)) return page;



  try {

    const pages = await browser.pages();

    for (let i = pages.length - 1; i >= 0; i--) {

      if (await usable(pages[i])) {
        log?.debug?.('Pagina reanexada apos navegacao.');
        browser.__realPage = pages[i];
        return focusPage(pages[i], log);
      }

    }

  } catch (e) {

    log?.debug?.('falha ao listar paginas:', e.message);

  }



  return page;

}



export async function closeBrowser(browser, log, { cleanupProfile = true, fast = false } = {}) {
  if (!browser) return;

  const userDataDir = browser.__userDataDir;
  const fresh = browser.__freshProfile;

  try {
    await browser.close();
  } catch (e) {
    log?.debug?.('erro ao fechar browser:', e.message);
  }

  if (cleanupProfile && fresh && userDataDir) {

    const removeProfile = () => wipeChromeProfileDir(userDataDir, log);

    setImmediate(removeProfile);

  }

}

/**
 * PID do chrome-launcher a partir da porta do CDP (puppeteer.connect nao expoe process()).
 */
function findChromePidByDebugPort(port) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return null;

  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${p}`, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
        shell: true,
      });
      const re = new RegExp(
        `(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|\\[::\\]):${p}\\s+\\S+\\s+LISTENING\\s+(\\d+)`,
        'i',
      );
      for (const line of String(out).split(/\r?\n/)) {
        const m = line.match(re);
        if (m) {
          const pid = parseInt(m[1], 10);
          if (Number.isFinite(pid) && pid > 0) return pid;
        }
      }
      return null;
    }

    const out = execSync(`lsof -t -iTCP:${p} -sTCP:LISTEN 2>/dev/null || true`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    const pid = parseInt(String(out).trim().split(/\s+/)[0], 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function attachChromePid(browser, log) {
  if (!browser || browser.__chromePid) return;
  try {
    const ws = typeof browser.wsEndpoint === 'function' ? browser.wsEndpoint() : '';
    const m = String(ws).match(/:(\d+)(?:\/|$)/);
    if (!m) return;
    const pid = findChromePidByDebugPort(m[1]);
    if (pid) {
      browser.__chromePid = pid;
      log?.debug?.(`Chrome PID ${pid} (CDP :${m[1]})`);
    }
  } catch (e) {
    log?.debug?.('attachChromePid falhou:', e.message);
  }
}

function isPidAlive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPidTree(pid, log) {
  if (!(pid > 0)) return false;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 10000,
        stdio: 'ignore',
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
    return true;
  } catch (e) {
    log?.debug?.(`killPidTree ${pid}:`, e.message);
    return false;
  }
}

/**
 * Forca morte do Chrome do perfil.
 * Necessario porque puppeteer-real-browser usa connect() — browser.process() e sempre null.
 * Sem isso, close() travado deixa Chrome zumbi e o pool abre mais janelas que o CONCURRENCY.
 */
function forceKillBrowserChrome(browser, log) {
  if (!browser) return;

  try {
    const proc = browser.process?.();
    if (proc && !proc.killed) {
      log?.warn?.('Forcando encerramento via browser.process().');
      proc.kill('SIGKILL');
    }
  } catch {
    /* noop */
  }

  const pid = browser.__chromePid;
  if (pid && isPidAlive(pid)) {
    log?.warn?.(`Forcando encerramento do Chrome PID ${pid}.`);
    killPidTree(pid, log);
  }

  // Fallback por perfil so se o PID nao bastou (connect sem PID, ou tree incompleta).
  if (!pid || isPidAlive(pid)) {
    const userDataDir = browser.__userDataDir;
    if (userDataDir) {
      const killed = killStaleChromeFromProfiles(log, { force: true, profilesDir: userDataDir });
      if (killed > 0) {
        log?.warn?.(`Chrome forçado pelo perfil (${killed} processo(s)).`);
      }
    }
  }

  try {
    if (typeof browser.disconnect === 'function') browser.disconnect();
  } catch {
    /* noop */
  }
}

/** Fecha browser com limite de tempo — evita instancia presa quando Chrome trava. */
export async function closeBrowserForced(browser, log, opts = {}) {
  if (!browser) return;

  const forceMs = opts.forceMs ?? 8000;
  const chromePid = browser.__chromePid;
  let closed = false;
  let timedOut = false;

  await Promise.race([
    closeBrowser(browser, log, opts).then(() => {
      closed = true;
    }),
    new Promise((resolve) => {
      setTimeout(() => {
        if (closed) return resolve();
        timedOut = true;
        log?.warn?.('Browser nao fechou a tempo — forcando encerramento.');
        forceKillBrowserChrome(browser, log);
        resolve();
      }, forceMs);
    }),
  ]);

  // close() via connect() pode "ok" sem matar o processo do chrome-launcher.
  if (!timedOut && chromePid && isPidAlive(chromePid)) {
    log?.warn?.(`Chrome PID ${chromePid} ainda vivo apos close — forcando.`);
    killPidTree(chromePid, log);
  }
}



export async function screenshot(page, name, log) {

  if (!config.screenshotOnError) return null;

  try {

    fs.mkdirSync(config.screenshotDir, { recursive: true });

    const file = path.join(config.screenshotDir, `${name}-${Date.now()}.png`);

    await page.screenshot({ path: file, fullPage: false });

    log?.debug?.('screenshot salva:', file);

    return file;

  } catch (e) {

    log?.debug?.('falha ao salvar screenshot:', e.message);

    return null;

  }

}


