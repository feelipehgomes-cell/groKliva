import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { SwitchToggle } from '../components/SwitchToggle';

type WaStatus = {
  session: { hasSession: boolean; connected: boolean; userId: string | null };
  hub: {
    connected: boolean;
    enabledGroupCount: number;
    commandsEnabled: boolean;
    whatsappEnabled: boolean;
    canRun: boolean;
  };
  login: {
    phase: string;
    qrDataUrl: string | null;
    message: string;
    error: string | null;
    inProgress: boolean;
  };
  settings: {
    whatsappEnabled: boolean;
    commandsEnabled: boolean;
    commandsPublic: boolean;
    adminPhones: string;
    sendReadyPixOnStop: boolean;
  };
  registeredGroups: number;
  authDir: string;
};

const WA_SETTING_KEYS = [
  'WHATSAPP_ENABLED',
  'WHATSAPP_COMMANDS_ENABLED',
  'WHATSAPP_COMMANDS_PUBLIC',
  'WHATSAPP_ADMIN_PHONES',
  'WHATSAPP_SEND_READY_PIX_ON_STOP',
] as const;

function phaseLabel(phase: string) {
  switch (phase) {
    case 'qr':
      return 'Aguardando QR';
    case 'connecting':
      return 'Conectando';
    case 'connected':
      return 'Conectado';
    case 'error':
      return 'Erro';
    default:
      return 'Pronto';
  }
}

export function WhatsAppPage() {
  const [status, setStatus] = useState<WaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      const data = await api.whatsappStatus();
      setStatus(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const data = await api.settings();
    const flat: Record<string, string> = {};
    const wa = (data.groups as Record<string, { fields: { key: string; value?: string }[] }>)
      ?.whatsapp;
    for (const field of wa?.fields || []) {
      flat[field.key] = field.value ?? '';
    }
    setSettings(flat);
  }, []);

  useEffect(() => {
    refresh();
    loadSettings().catch(console.error);
  }, [refresh, loadSettings]);

  useEffect(() => {
    const polling = status?.login?.inProgress || ['qr', 'connecting'].includes(status?.login?.phase || '');
    if (!polling) return;
    const id = setInterval(() => refresh(), 2000);
    return () => clearInterval(id);
  }, [status?.login?.inProgress, status?.login?.phase, refresh]);

  const run = async (action: string, fn: () => Promise<unknown>) => {
    setBusy(action);
    try {
      await fn();
      await refresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(msg);
      await refresh();
    } finally {
      setBusy('');
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsMsg('');
    try {
      const payload: Record<string, string> = {};
      for (const key of WA_SETTING_KEYS) {
        if (settings[key] !== undefined) payload[key] = settings[key];
      }
      await api.saveSettings(payload);
      setSettingsMsg('Salvo. Reinicie o KLIVA (dev:kliva) para aplicar no hub.');
      await refresh();
      await loadSettings();
    } catch (err: unknown) {
      setSettingsMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSettings(false);
    }
  };

  if (loading && !status) {
    return (
      <div className="header">
        <h2>WhatsApp</h2>
        <p>Carregando...</p>
      </div>
    );
  }

  const sessionOk = status?.session?.connected;
  const hubOk = status?.hub?.connected;
  const loginPhase = status?.login?.phase || 'idle';

  return (
    <>
      <div className="header">
        <div>
          <h2>WhatsApp</h2>
          <p>Conexão por QR, hub de comandos e parâmetros do bot</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!!busy}
          onClick={() => run('refresh', refresh)}
        >
          Atualizar
        </button>
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <p className="card-title">Sessão Baileys</p>
          <div className="wa-status-grid">
            <div>
              <span className="wa-status-label">Sessão salva</span>
              <span className={`badge ${status?.session?.hasSession ? 'badge-running' : 'badge-idle'}`}>
                {status?.session?.hasSession ? 'Sim' : 'Não'}
              </span>
            </div>
            <div>
              <span className="wa-status-label">Socket</span>
              <span className={`badge ${sessionOk ? 'badge-running' : 'badge-idle'}`}>
                {sessionOk ? 'Conectado' : 'Desconectado'}
              </span>
            </div>
            <div>
              <span className="wa-status-label">Usuário</span>
              <span className="cell-muted">{status?.session?.userId || '—'}</span>
            </div>
            <div>
              <span className="wa-status-label">Pasta auth</span>
              <span className="cell-muted">{status?.authDir}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <p className="card-title">Hub de comandos</p>
          <div className="wa-status-grid">
            <div>
              <span className="wa-status-label">Hub</span>
              <span className={`badge ${hubOk ? 'badge-running' : 'badge-idle'}`}>
                {hubOk ? 'Ativo' : 'Inativo'}
              </span>
            </div>
            <div>
              <span className="wa-status-label">Grupos com /start</span>
              <span>{status?.hub?.enabledGroupCount ?? 0}</span>
            </div>
            <div>
              <span className="wa-status-label">Comandos no .env</span>
              <span>{status?.hub?.commandsEnabled ? 'Ligado' : 'Desligado'}</span>
            </div>
            <div>
              <span className="wa-status-label">Grupos cadastrados</span>
              <span>
                {status?.registeredGroups ?? 0}{' '}
                <Link to="/grupos" className="wa-inline-link">
                  gerenciar
                </Link>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <p className="card-title">Login por QR</p>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          Celular: WhatsApp → Dispositivos conectados → Conectar dispositivo → Escanear QR
        </p>

        <div className="wa-login-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!busy || status?.login?.inProgress}
            onClick={() => run('login', () => api.whatsappLoginStart(true))}
          >
            {busy === 'login' ? 'Gerando QR...' : 'Conectar com QR'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!!busy || status?.login?.inProgress}
            onClick={() => run('login-force', () => api.whatsappLoginStart(true))}
          >
            Novo QR (limpa sessão)
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!!busy || !status?.login?.inProgress}
            onClick={() => run('cancel', () => api.whatsappLoginCancel())}
          >
            Cancelar login
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!!busy}
            onClick={() => run('hub', () => api.whatsappHubReconnect())}
          >
            Reativar hub
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!!busy}
            onClick={() => {
              if (!confirm('Remover sessão WhatsApp desta máquina?')) return;
              run('disconnect', () => api.whatsappDisconnect());
            }}
          >
            Desconectar
          </button>
        </div>

        <div className="wa-login-status">
          <span className={`badge ${loginPhase === 'connected' || sessionOk ? 'badge-running' : loginPhase === 'error' ? 'badge-idle' : 'badge-idle'}`}>
            {phaseLabel(loginPhase)}
          </span>
          <span style={{ color: 'var(--text-muted)' }}>
            {status?.login?.message || (sessionOk ? 'Sessão ativa.' : 'Nenhum login em andamento.')}
          </span>
          {status?.login?.error && (
            <span style={{ color: 'var(--danger)' }}>{status.login.error}</span>
          )}
        </div>

        {status?.login?.qrDataUrl && (
          <div className="wa-qr-wrap">
            <img src={status.login.qrDataUrl} alt="QR Code WhatsApp" className="wa-qr-image" />
          </div>
        )}
      </div>

      <form onSubmit={saveSettings} className="card">
        <p className="card-title">Configurações</p>
        <div className="grid-2">
          <div className="form-row">
            <label>WhatsApp ativo</label>
            <SwitchToggle
              checked={settings.WHATSAPP_ENABLED === 'true'}
              onChange={() =>
                setSettings((s) => ({
                  ...s,
                  WHATSAPP_ENABLED: s.WHATSAPP_ENABLED === 'true' ? 'false' : 'true',
                }))
              }
              label={settings.WHATSAPP_ENABLED === 'true' ? 'Sim' : 'Não'}
            />
          </div>
          <div className="form-row">
            <label>Comandos /start /stop /status</label>
            <SwitchToggle
              checked={settings.WHATSAPP_COMMANDS_ENABLED === 'true'}
              onChange={() =>
                setSettings((s) => ({
                  ...s,
                  WHATSAPP_COMMANDS_ENABLED:
                    s.WHATSAPP_COMMANDS_ENABLED === 'true' ? 'false' : 'true',
                }))
              }
              label={settings.WHATSAPP_COMMANDS_ENABLED === 'true' ? 'Ativo' : 'Desativado'}
            />
          </div>
          <div className="form-row">
            <label>Qualquer membro pode usar comandos</label>
            <SwitchToggle
              checked={settings.WHATSAPP_COMMANDS_PUBLIC === 'true'}
              onChange={() =>
                setSettings((s) => ({
                  ...s,
                  WHATSAPP_COMMANDS_PUBLIC:
                    s.WHATSAPP_COMMANDS_PUBLIC === 'true' ? 'false' : 'true',
                }))
              }
              label={settings.WHATSAPP_COMMANDS_PUBLIC === 'true' ? 'Público' : 'Só admins'}
            />
          </div>
          <div className="form-row">
            <label>Enviar contas prontas ao parar (só CLI)</label>
            <SwitchToggle
              checked={settings.WHATSAPP_SEND_READY_PIX_ON_STOP === 'true'}
              onChange={() =>
                setSettings((s) => ({
                  ...s,
                  WHATSAPP_SEND_READY_PIX_ON_STOP:
                    s.WHATSAPP_SEND_READY_PIX_ON_STOP === 'true' ? 'false' : 'true',
                }))
              }
              label={settings.WHATSAPP_SEND_READY_PIX_ON_STOP === 'true' ? 'Sim' : 'Não'}
            />
            <small style={{ color: 'var(--text-muted)' }}>
              Na interface KLIVA, use o toggle &quot;Enviar prontas&quot; em cada grupo.
            </small>
          </div>
          <div className="form-row" style={{ gridColumn: '1 / -1' }}>
            <label>Telefones admin (DDI+DDD+número, vírgula)</label>
            <input
              className="input"
              value={settings.WHATSAPP_ADMIN_PHONES ?? ''}
              placeholder="5573991560536,5511999999999"
              onChange={(e) =>
                setSettings((s) => ({ ...s, WHATSAPP_ADMIN_PHONES: e.target.value }))
              }
            />
            <small style={{ color: 'var(--text-muted)' }}>
              Usado quando &quot;Qualquer membro&quot; está desligado.
            </small>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
          <button className="btn btn-primary" type="submit" disabled={savingSettings}>
            {savingSettings ? 'Salvando...' : 'Salvar configurações'}
          </button>
          {settingsMsg && <span style={{ color: 'var(--text-muted)' }}>{settingsMsg}</span>}
        </div>
      </form>
    </>
  );
}
