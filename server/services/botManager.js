import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ROOT_DIR } from '../../bot/shared/config.js';
import { getActivateScript, isReleaseBuild } from '../../bot/shared/releasePaths.js';
import { killStaleChromeFromProfiles, resolveProfilesRoot } from '../../bot/shared/browser/browser.js';
import { getEnvMap } from './settingsStore.js';
import { getGroupById, ensureGroupDirs, groupSendReadyPixEnabled } from './groupStore.js';
import { getPaidEmails } from '../../bot/shared/pix/paidStore.js';

const BOT_CONFIG = {
  activate: {
    get script() {
      return getActivateScript();
    },
    label: 'Ativar via PIX',
  },
};

function sendReadyPixOnStopForGroup(group) {
  return group?.sendReadyPix === true;
}

// Lock em disco para sobreviver a restart do servidor (ex.: --watch em dev, crash em prod).
// O mapa em memoria e recriado a cada restart, mas os processos filhos (activate + Chrome)
// continuam vivos; o lock rastreia o run pelo PID para manter a exclusao global (um por vez).
const ACTIVATE_LOCK_FILE = path.join(ROOT_DIR, 'data', 'activate.lock');

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readActivateLock() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVATE_LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeActivateLock(data) {
  try {
    fs.mkdirSync(path.dirname(ACTIVATE_LOCK_FILE), { recursive: true });
    fs.writeFileSync(ACTIVATE_LOCK_FILE, JSON.stringify(data), 'utf8');
  } catch {
    /* noop */
  }
}

function clearActivateLock() {
  try {
    fs.rmSync(ACTIVATE_LOCK_FILE, { force: true });
  } catch {
    /* noop */
  }
}

class BotManager extends EventEmitter {
  constructor() {
    super();
    this.processes = {
      activate: new Map(),
    };
    this.logBuffers = {
      activate: new Map(),
    };
    this.maxLogLines = 500;
  }

  isActivateRunning(groupId) {
    const proc = this.processes.activate.get(groupId);
    if (proc && !proc.killed) return true;
    const lock = readActivateLock();
    return !!(lock && lock.groupId === groupId && isPidAlive(lock.pid));
  }

  /** Retorna o ativador em execucao (unico permitido globalmente) ou null. */
  getRunningActivate() {
    for (const [groupId, proc] of this.processes.activate.entries()) {
      if (proc && !proc.killed) {
        return { groupId, proc, group: getGroupById(groupId), pid: proc.pid };
      }
    }
    // Sem handle em memoria: pode ser um run orfao apos restart do servidor.
    const lock = readActivateLock();
    if (lock?.pid && isPidAlive(lock.pid)) {
      return {
        groupId: lock.groupId,
        proc: null,
        group: getGroupById(lock.groupId),
        pid: lock.pid,
        orphaned: true,
      };
    }
    if (lock) clearActivateLock();
    return null;
  }

  getActivateStatus() {
    const out = {};
    for (const [groupId, proc] of this.processes.activate.entries()) {
      out[groupId] = {
        running: !!proc && !proc.killed,
        pid: proc?.pid ?? null,
        startedAt: proc?.startedAt ?? null,
        startOptions: proc?.startOptions ?? null,
        groupId,
        label: BOT_CONFIG.activate.label,
      };
    }
    // Inclui run orfao (rastreado so pelo lock) para a UI/comandos refletirem a exclusao.
    const lock = readActivateLock();
    if (lock?.pid && isPidAlive(lock.pid) && !out[lock.groupId]) {
      out[lock.groupId] = {
        running: true,
        pid: lock.pid,
        startedAt: lock.startedAt ?? null,
        startOptions: null,
        groupId: lock.groupId,
        label: BOT_CONFIG.activate.label,
        orphaned: true,
      };
    }
    return out;
  }

  getStatus() {
    const activateMap = this.getActivateStatus();
    const anyActivateRunning = Object.values(activateMap).some((s) => s.running);
    const runningGroupId = this.getRunningActivate()?.groupId ?? null;

    return {
      activate: activateMap,
      anyRunning: anyActivateRunning,
      anyActivateRunning,
      runningGroupId,
    };
  }

  getLogs(name, since = 0, groupId = null) {
    if (name === 'activate') {
      if (!groupId) return [];
      const buf = this.logBuffers.activate.get(groupId) || [];
      return buf.slice(since);
    }
    return [];
  }

  appendLog(name, line, stream = 'stdout', groupId = null) {
    const entry = { ts: Date.now(), line, stream };
    if (name === 'activate') {
      if (!groupId) return;
      let buf = this.logBuffers.activate.get(groupId);
      if (!buf) {
        buf = [];
        this.logBuffers.activate.set(groupId, buf);
      }
      buf.push(entry);
      if (buf.length > this.maxLogLines) buf.splice(0, buf.length - this.maxLogLines);
      this.emit('log', name, entry, groupId);
    }
  }

  clearLogs(name, groupId = null) {
    if (name === 'activate' && groupId) {
      this.logBuffers.activate.set(groupId, []);
      return;
    }
    if (name === 'activate') {
      this.logBuffers.activate.clear();
    }
  }

  resolveConcurrency(options = {}) {
    const explicit = Number(options.concurrency);
    if (Number.isFinite(explicit) && explicit >= 1) return explicit;
    const fromEnv = parseInt(getEnvMap().CONCURRENCY, 10);
    if (Number.isFinite(fromEnv) && fromEnv >= 1) return fromEnv;
    return 1;
  }

  resolveActivateLimit(options = {}) {
    if (options.limit !== undefined && options.limit !== null && options.limit !== '') {
      const explicit = Number(options.limit);
      if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
    }
    const fromEnv = parseInt(getEnvMap().ACTIVATE_ACCOUNT_LIMIT, 10);
    if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
    return 0;
  }

  async start(name, options = {}) {
    if (!BOT_CONFIG[name]) throw new Error(`Bot desconhecido: ${name}`);

    if (name === 'activate') {
      const groupId = String(options.groupId || '').trim();
      if (!groupId) throw new Error('groupId obrigatorio para iniciar o ativador');
      const group = getGroupById(groupId);
      if (!group) throw new Error(`Grupo nao encontrado: ${groupId}`);
      if (group.enabled === false) {
        throw new Error(`Grupo "${group.label}" esta desativado (comandos desligados)`);
      }
      const running = this.getRunningActivate();
      if (running) {
        if (running.groupId === groupId) {
          throw new Error(`Ativador ja rodando no grupo "${group.label}"`);
        }
        const label = running.group?.label || running.groupId;
        throw new Error(
          `Ja existe um ativador rodando no grupo "${label}". Pare-o antes de iniciar outro.`,
        );
      }
    }

    const startOptions = { ...options };
    const concurrency = this.resolveConcurrency(options);
    startOptions.concurrency = concurrency;

    const args = [BOT_CONFIG[name].script];
    let envExtra = {};

    if (name === 'activate') {
      const group = getGroupById(options.groupId);
      const paths = ensureGroupDirs(group.slug);
      const limit = this.resolveActivateLimit(options);
      startOptions.limit = limit;
      startOptions.groupId = group.id;
      startOptions.groupSlug = group.slug;
      startOptions.groupLabel = group.label;
      startOptions.baselinePaidEmails = new Set(getPaidEmails());
      args.push(`--concurrency=${concurrency}`);
      args.push(`--group-id=${group.id}`);
      if (limit > 0) args.push(`--limit=${limit}`);

      const rel = (abs) => path.relative(ROOT_DIR, abs).replace(/\\/g, '/');
      envExtra = {
        KLIVA_GROUP_ID: group.id,
        KLIVA_GROUP_SLUG: group.slug,
        WHATSAPP_GROUP_ID: group.id,
        WHATSAPP_SEND_READY_PIX_ON_STOP: sendReadyPixOnStopForGroup(group) ? 'true' : 'false',
        RESULTS_FILE: rel(paths.resultsFile),
        CHROME_PROFILES_DIR: rel(path.join(paths.baseDir, 'chrome-profiles')),
      };
    }

    if (options.headful) args.push('--headful');
    if (options.noProxy) args.push('--no-proxy');
    args.push('--simple-logs');

    this.clearLogs('activate', startOptions.groupId);

    const env = {
      ...process.env,
      KLIVA_ROOT: ROOT_DIR,
      KLIVA_MANAGED: '1',
      KLIVA_PORT: String(process.env.KLIVA_PORT || 4000),
      ...getEnvMap(),
      ...envExtra,
      CONCURRENCY: String(concurrency),
    };
    // So no release (dev/fonte): nao forcar KLIVA_RELEASE — evita exigir secret embarcado.
    // No pacote de venda, o launcher ja define KLIVA_RELEASE=1.
    if (isReleaseBuild() || process.env.KLIVA_RELEASE === '1') {
      env.KLIVA_RELEASE = '1';
    } else {
      delete env.KLIVA_RELEASE;
    }
    if (options.skipWhatsappStartNotice) {
      env.KLIVA_SKIP_WA_START_NOTICE = '1';
    }

    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });

    child.startedAt = new Date().toISOString();
    child.startOptions = startOptions;

    this.processes.activate.set(startOptions.groupId, child);
    writeActivateLock({
      groupId: startOptions.groupId,
      groupLabel: startOptions.groupLabel,
      pid: child.pid,
      startedAt: child.startedAt,
    });

    const logGroupId = startOptions.groupId;

    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line) this.appendLog(name, line, 'stdout', logGroupId);
      }
    });

    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line) this.appendLog(name, line, 'stderr', logGroupId);
      }
    });

    child.on('exit', (code, signal) => {
      this.appendLog(
        name,
        `[processo encerrado code=${code} signal=${signal}]`,
        'system',
        logGroupId,
      );
      this.processes.activate.delete(startOptions.groupId);
      const lock = readActivateLock();
      if (lock && lock.pid === child.pid) clearActivateLock();
      this.emit('exit', name, { code, signal, groupId: startOptions.groupId });
      const exitOpts = { ...startOptions };
      setTimeout(() => {
        this._maybeSendReadyPixOnActivateExit(exitOpts).catch((err) => {
          this.appendLog(
            'activate',
            `[ready-pix backup falhou: ${err.message}]`,
            'stderr',
            exitOpts.groupId,
          );
        });
      }, 3000);
    });

    return {
      pid: child.pid,
      startedAt: child.startedAt,
      concurrency,
      groupId: startOptions.groupId || null,
    };
  }

  async _maybeSendReadyPixOnActivateExit(startOptions = {}) {
    const { groupId, groupSlug, baselinePaidEmails } = startOptions;
    if (!groupId || !groupSendReadyPixEnabled(groupId)) return;

    const { accountsReadyFromRunDelta, markReadyAccountsReleased } = await import(
      './readyAccountsStore.js'
    );
    const { getPaidCredentials } = await import('../../bot/shared/pix/paidStore.js');
    const { sendReadyPixAccountsToGroup } = await import(
      '../../bot/shared/whatsapp/whatsapp.js'
    );

    const passwordMap = new Map();
    for (const [email, password] of getPaidCredentials()) {
      if (email && password) passwordMap.set(email, password);
    }

    const accounts = accountsReadyFromRunDelta({
      runResults: [],
      passwordMap,
      baselinePaidEmails: baselinePaidEmails || null,
      groupSlug: groupSlug || null,
    });
    if (!accounts.length) return;

    const log = {
      info: (msg) => this.appendLog('activate', msg, 'stdout', groupId),
      warn: (msg) => this.appendLog('activate', msg, 'stderr', groupId),
      debug: () => {},
      error: (msg) => this.appendLog('activate', msg, 'stderr', groupId),
    };

    log.info(
      `WhatsApp backup: ${accounts.length} conta(s) paga(s) desta run — enviando no grupo...`,
    );

    const result = await sendReadyPixAccountsToGroup({
      accounts,
      interrupted: true,
      log,
      force: true,
      groupId,
    });

    if (result?.sent) {
      const mark = markReadyAccountsReleased(
        'activate',
        accounts.map((a) => a.email),
        passwordMap,
        groupSlug || null,
      );
      log.info(
        `WhatsApp backup: ${result.count ?? accounts.length} conta(s) enviada(s) (released: ${mark.released}).`,
      );
    } else if (result?.reason && result.reason !== 'empty') {
      log.warn(`WhatsApp backup contas PIX nao enviadas: ${result.reason}`);
    }
  }

  async stop(name, options = {}) {
    if (name === 'activate') {
      const groupId = String(options.groupId || '').trim();
      if (!groupId) throw new Error('groupId obrigatorio para parar o ativador');
      const proc = this.processes.activate.get(groupId);
      if (proc && !proc.killed) return this._stopProcess(proc);
      // Sem handle em memoria: run orfao apos restart do servidor, rastreado so pelo lock.
      const lock = readActivateLock();
      if (lock && lock.groupId === groupId && isPidAlive(lock.pid)) {
        return this._stopOrphan(lock);
      }
      return { stopped: false, reason: 'not_running' };
    }

    throw new Error(`Bot desconhecido: ${name}`);
  }

  async _stopOrphan(lock) {
    const group = getGroupById(lock.groupId);
    const profilesDir = group?.slug
      ? path.join(ROOT_DIR, 'data', 'groups', group.slug, 'chrome-profiles')
      : resolveProfilesRoot();

    try {
      process.kill(lock.pid, 'SIGTERM');
    } catch {
      /* ja morto */
    }
    await new Promise((r) => setTimeout(r, 4000));
    if (isPidAlive(lock.pid)) {
      try {
        process.kill(lock.pid, 'SIGKILL');
      } catch {
        /* ja morto */
      }
    }
    killStaleChromeFromProfiles(null, { force: true, profilesDir });
    clearActivateLock();
    return { stopped: true, orphaned: true };
  }

  resolveStopProfilesDir(proc) {
    const slug = proc?.startOptions?.groupSlug;
    if (slug) {
      return path.join(ROOT_DIR, 'data', 'groups', slug, 'chrome-profiles');
    }
    return resolveProfilesRoot();
  }

  async _stopProcess(proc) {
    const GRACE_MS = 35000;
    const CHROME_KILL_MS = 4000;
    const profilesDir = this.resolveStopProfilesDir(proc);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        clearTimeout(chromeKillTimer);
        resolve(result);
      };

      const chromeKillTimer = setTimeout(() => {
        killStaleChromeFromProfiles(null, { force: true, profilesDir });
      }, CHROME_KILL_MS);

      const forceTimer = setTimeout(() => {
        killStaleChromeFromProfiles(null, { force: true, profilesDir });
        if (!proc.killed) proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
          finish({ stopped: true, forced: true });
        }, 5000);
      }, GRACE_MS);

      proc.once('exit', () => finish({ stopped: true }));

      if (typeof proc.send === 'function') {
        try {
          proc.send({ type: 'graceful-stop' });
        } catch {
          if (process.platform === 'win32') {
            proc.kill('SIGTERM');
          } else {
            proc.kill('SIGINT');
          }
        }
      } else if (process.platform === 'win32') {
        proc.kill('SIGTERM');
      } else {
        proc.kill('SIGINT');
      }
    });
  }
}

export const botManager = new BotManager();
