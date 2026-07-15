import { useCallback, useEffect, useState } from 'react';
import { api, connectBotLogs } from '../api/client';
import { LogTerminal } from '../components/LogTerminal';
import { ReadyAccountsPanel } from '../components/ReadyAccountsPanel';
import type { ReadyAccount } from '../components/ReadyAccountsPanel';
import { botPrefs, persistActivateOpts } from '../utils/botPrefs';

type GroupSummary = {
  id: string;
  label: string;
  slug: string;
  enabled?: boolean;
  accountsTotal: number;
  activatedCount: number;
  activatedToday: number;
  running: boolean;
  readyActivate?: ReadyAccount[];
};

function GroupCard({
  group,
  stopping,
  blockedByOther,
  togglingCommands,
  onStart,
  onStop,
  onReset,
  onToggleCommands,
}: {
  group: GroupSummary;
  stopping: boolean;
  blockedByOther: boolean;
  togglingCommands: boolean;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onToggleCommands: () => void;
}) {
  const commandsOn = group.enabled !== false;
  const startDisabled = !commandsOn || blockedByOther;
  const startTitle = !commandsOn
    ? 'Ative os comandos em Grupos WhatsApp'
    : blockedByOther
      ? 'Outro grupo esta rodando'
      : undefined;
  const readyCount = group.readyActivate?.length ?? 0;

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <p className="card-title" style={{ margin: 0 }}>
            {group.label}
          </p>
          <span
            className={`badge ${stopping || group.running ? 'badge-running' : 'badge-idle'}`}
          >
            {stopping ? 'Parando...' : group.running ? 'Rodando' : 'Parado'}
          </span>
          {!commandsOn && (
            <span className="badge badge-idle" style={{ marginLeft: 6 }} title="Comandos WhatsApp desativados neste grupo">
              Comandos off
            </span>
          )}
          <span style={{ display: 'block', marginTop: 6, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {readyCount === 1 ? '1 conta pronta' : `${readyCount} contas prontas`}
          </span>
        </div>
        {!group.running && !stopping ? (
          <button
            type="button"
            className="btn btn-primary"
            style={{ padding: '8px 16px', fontSize: '0.85rem' }}
            disabled={startDisabled}
            title={startTitle}
            onClick={onStart}
          >
            Iniciar
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-danger"
            style={{ padding: '8px 16px', fontSize: '0.85rem' }}
            disabled={stopping}
            onClick={onStop}
          >
            {stopping ? 'Parando...' : 'Pausar'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 16, gap: 8 }}>
        <div style={{ display: 'flex', gap: 20 }}>
          <div>
            <div className="metric-value" style={{ fontSize: '1.5rem' }}>
              {group.activatedCount}
            </div>
            <div className="metric-label">Marcador do grupo</div>
          </div>
          <div>
            <div className="metric-value" style={{ fontSize: '1.5rem' }}>
              {group.activatedToday}
            </div>
            <div className="metric-label">Ativadas hoje</div>
          </div>
        </div>
        <div className="card-actions">
          <button
            type="button"
            className={`btn btn-sm ${commandsOn ? 'btn-danger' : 'btn-primary'}`}
            disabled={togglingCommands}
            title={
              commandsOn
                ? 'Para de receber /start /stop /status /count'
                : 'Reativar comandos WhatsApp neste grupo'
            }
            onClick={onToggleCommands}
          >
            {togglingCommands ? 'Salvando...' : commandsOn ? 'Desativar' : 'Ativar'}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onReset}>
            Zerar marcador
          </button>
        </div>
      </div>
    </div>
  );
}

function TerminalLogs({
  groupId,
  label,
  running,
}: {
  groupId: string | null;
  label: string | null;
  running: boolean;
}) {
  const [logs, setLogs] = useState<{ line: string; stream: string }[]>([]);

  useEffect(() => {
    setLogs([]);
    if (!groupId) return;
    const disconnect = connectBotLogs('activate', (entry) => {
      setLogs((prev) => [
        ...prev.slice(-499),
        { line: entry.line, stream: entry.stream },
      ]);
    }, groupId);
    return disconnect;
  }, [groupId]);

  return (
    <div className="activity-panel">
      <div className="activity-panel-header">
        <p className="card-title" style={{ margin: 0 }}>
          Logs
          {label && <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>— {label}</span>}
          {running && <span className="badge badge-running" style={{ marginLeft: 8 }}>ao vivo</span>}
        </p>
      </div>
      <div className="activity-panel-body">
        <LogTerminal
          logs={logs}
          emptyMessage={
            groupId
              ? 'Sem logs recentes deste bot.'
              : 'Nenhum bot em execucao. Inicie um grupo acima.'
          }
        />
      </div>
    </div>
  );
}

export function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const [stoppingGroup, setStoppingGroup] = useState<string | null>(null);
  const [togglingCommandsId, setTogglingCommandsId] = useState<string | null>(null);
  const [logGroupId, setLogGroupId] = useState<string | null>(null);
  const [readyGroupId, setReadyGroupId] = useState<string>('all');

  const refresh = useCallback(() => {
    api.dashboard().then(setData).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const runningGroupId: string | null = data?.bots?.runningGroupId ?? null;

  useEffect(() => {
    if (runningGroupId) setLogGroupId(runningGroupId);
  }, [runningGroupId]);

  if (!data) {
    return (
      <div className="header">
        <h2>Dashboard</h2>
        <p>Carregando...</p>
      </div>
    );
  }

  const groups: GroupSummary[] = data.groups || [];
  const anyRunning = !!data.bots?.anyActivateRunning;
  const logGroup = groups.find((g) => g.id === logGroupId) || null;
  const readyGroup = groups.find((g) => g.id === readyGroupId) || null;
  const readyAccounts =
    readyGroupId === 'all' ? data.readyActivate || [] : readyGroup?.readyActivate || [];

  const handleStartActivate = async (groupId: string) => {
    try {
      const opts = botPrefs.loadActivate();
      await persistActivateOpts(opts);
      await api.startActivate({
        groupId,
        limit: opts.limit,
        concurrency: opts.concurrency,
      });
      setLogGroupId(groupId);
      refresh();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleStopActivate = async (groupId: string) => {
    setStoppingGroup(groupId);
    try {
      await api.stopActivate(groupId);
      refresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setStoppingGroup(null);
    }
  };

  const handleResetStats = async (groupId: string) => {
    const g = groups.find((x) => x.id === groupId);
    if (!confirm(`Zerar contador de ativadas do grupo "${g?.label}"?`)) return;
    try {
      await api.resetGroupStats(groupId);
      refresh();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleToggleCommands = async (groupId: string, enabled: boolean) => {
    setTogglingCommandsId(groupId);
    try {
      await api.setGroupEnabled(groupId, enabled);
      refresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setTogglingCommandsId(null);
    }
  };

  return (
    <div className="dashboard-page">
      <div className="header">
        <div>
          <h2>Dashboard</h2>
          <p>Hoje — {new Date().toLocaleDateString('pt-BR')}</p>
        </div>
      </div>

      <div className="card dashboard-metrics">
        <div className="grid-2">
          <div>
            <div className="metric-value purple">{data.activatedTotal ?? 0}</div>
            <div className="metric-label">Total ativadas pelo bot</div>
          </div>
          <div>
            <div className="metric-value">{data.activatedToday ?? 0}</div>
            <div className="metric-label">Ativadas hoje</div>
          </div>
        </div>
      </div>

      <div className="card dashboard-activity">
        <div className="dashboard-activity-body">
          <div className="dashboard-activity-tab">
            <div className="card dashboard-status dashboard-status--groups">
              <p className="card-title">Ativador por grupo</p>
              {groups.length === 0 ? (
                <p style={{ color: 'var(--text-muted)' }}>
                  Cadastre grupos em &quot;Grupos WhatsApp&quot;.
                </p>
              ) : (
                <div className="bot-status-grid-scroll">
                  <div className="grid-2" style={{ gap: 12 }}>
                    {groups.map((g) => (
                      <GroupCard
                        key={g.id}
                        group={g}
                        stopping={stoppingGroup === g.id}
                        blockedByOther={anyRunning && !g.running}
                        togglingCommands={togglingCommandsId === g.id}
                        onStart={() => handleStartActivate(g.id)}
                        onStop={() => handleStopActivate(g.id)}
                        onReset={() => handleResetStats(g.id)}
                        onToggleCommands={() => handleToggleCommands(g.id, g.enabled === false)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="activity-split dashboard-ativador-split">
              <TerminalLogs
                groupId={logGroupId}
                label={logGroup?.label ?? null}
                running={!!logGroup?.running}
              />
              <ReadyAccountsPanel
                kind="activate"
                accounts={readyAccounts}
                accountsLabel="Contas prontas"
                groups={groups.map((g) => ({ id: g.id, label: g.label }))}
                groupId={readyGroupId}
                onGroupChange={setReadyGroupId}
                onReleased={refresh}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
