import { spawn } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ROOT_DIR } from '../../bot/shared/config.js';
import { killStaleChromeFromProfiles, resolveProfilesRoot } from '../../bot/shared/browser/browser.js';
import { getEnvMap } from './settingsStore.js';
import { getGroupById, ensureGroupDirs, groupSendReadyPixEnabled } from './groupStore.js';
import { getPaidEmails } from '../../bot/shared/pix/paidStore.js';

const BOT_CONFIG = {
  generate: {
    script: path.join(ROOT_DIR, 'bot/generate/cli.js'),
    label: 'Gerar contas',
  },
  activate: {
    script: path.join(ROOT_DIR, 'bot/activate/cli.js'),
    label: 'Ativar via PIX',
  },
};

function envTruthy(raw) {
  if (raw === undefined || raw === null || raw === '') return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase());
}

function sendReadyPixOnStopForGroup(group) {
  if (group?.sendReadyPix === true) return true;
  return envTruthy(getEnvMap().WHATSAPP_SEND_READY_PIX_ON_STOP);
}

class BotManager extends EventEmitter {
  constructor() {
    super();
    this.processes = {
      generate: null,
      activate: new Map(),
    };
    this.logBuffers = {
      generate: [],
      activate: new Map(),
    };
    this.maxLogLines = 500;
  }

  isActivateRunning(groupId) {
    const proc = this.processes.activate.get(groupId);
    return !!proc && !proc.killed;
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
    return out;
  }

  getStatus() {
    const generateProc = this.processes.generate;
    const activateMap = this.getActivateStatus();
    const anyActivateRunning = Object.values(activateMap).some((s) => s.running);

    const status = {
      generate: {
        running: !!generateProc && !generateProc.killed,
        pid: generateProc?.pid ?? null,
        startedAt: generateProc?.startedAt ?? null,
        startOptions: generateProc?.startOptions ?? null,
        label: BOT_CONFIG.generate.label,
      },
      activate: activateMap,
      anyRunning:
        (!!generateProc && !generateProc.killed) || anyActivateRunning,
      anyActivateRunning,
    };

    return status;
  }

  getLogs(name, since = 0, groupId = null) {
    if (name === 'activate') {
      if (!groupId) return [];
      const buf = this.logBuffers.activate.get(groupId) || [];
      return buf.slice(since);
    }
    const buf = this.logBuffers[name] || [];
    return buf.slice(since);
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
      return;
    }
    const buf = this.logBuffers[name];
    buf.push(entry);
    if (buf.length > this.maxLogLines) buf.splice(0, buf.length - this.maxLogLines);
    this.emit('log', name, entry);
  }

  clearLogs(name, groupId = null) {
    if (name === 'activate' && groupId) {
      this.logBuffers.activate.set(groupId, []);
      return;
    }
    if (name === 'activate') {
      this.logBuffers.activate.clear();
      return;
    }
    this.logBuffers[name] = [];
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

    if (name === 'generate') {
      if (this.processes.generate && !this.processes.generate.killed) {
        throw new Error(`${BOT_CONFIG[name].label} ja esta rodando`);
      }
    }

    if (name === 'activate') {
      const groupId = String(options.groupId || '').trim();
      if (!groupId) throw new Error('groupId obrigatorio para iniciar o ativador');
      const group = getGroupById(groupId);
      if (!group) throw new Error(`Grupo nao encontrado: ${groupId}`);
      if (group.enabled === false) {
        throw new Error(`Grupo "${group.label}" esta desativado (comandos desligados)`);
      }
      if (this.isActivateRunning(groupId)) {
        throw new Error(`Ativador ja rodando no grupo "${group.label}"`);
      }
    }

    const startOptions = { ...options };
    const concurrency = this.resolveConcurrency(options);
    startOptions.concurrency = concurrency;

    const args = [BOT_CONFIG[name].script];
    let envExtra = {};

    if (name === 'generate') {
      const count = Number(options.count) > 0 ? Number(options.count) : 1;
      startOptions.count = count;
      args.push(`--count=${count}`);
      args.push(`--concurrency=${concurrency}`);
    } else if (name === 'activate') {
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

    if (name === 'activate') {
      this.clearLogs('activate', startOptions.groupId);
    } else {
      this.clearLogs(name);
    }

    const env = {
      ...process.env,
      KLIVA_MANAGED: '1',
      KLIVA_PORT: String(process.env.KLIVA_PORT || 4000),
      ...getEnvMap(),
      ...envExtra,
      CONCURRENCY: String(concurrency),
    };
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

    if (name === 'activate') {
      this.processes.activate.set(startOptions.groupId, child);
    } else {
      this.processes.generate = child;
    }

    const logGroupId = name === 'activate' ? startOptions.groupId : null;

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
      if (name === 'activate') {
        this.processes.activate.delete(startOptions.groupId);
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
      } else {
        this.processes.generate = null;
        this.emit('exit', name, { code, signal });
      }
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
      if (!proc || proc.killed) return { stopped: false, reason: 'not_running' };
      return this._stopProcess(proc);
    }

    const proc = this.processes[name];
    if (!proc || proc.killed) return { stopped: false, reason: 'not_running' };
    return this._stopProcess(proc);
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
