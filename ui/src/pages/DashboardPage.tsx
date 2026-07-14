import { useCallback, useEffect, useState } from 'react';
import { api, connectBotLogs } from '../api/client';
import { LogTerminal } from '../components/LogTerminal';
import { ReadyAccountsPanel } from '../components/ReadyAccountsPanel';
import type { ReadyAccount } from '../components/ReadyAccountsPanel';
import { botPrefs, persistActivateOpts, persistConcurrency } from '../utils/botPrefs';

type Tab = 'resumo' | 'gerador' | 'ativador';

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

function GroupBotControl({
  group,
  stopping,
  onStart,
  onStop,
}: {
  group: GroupSummary;
  stopping: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const commandsOn = group.enabled !== false;
  return (
    <div className="bot-status-row">
      <div className="bot-status-info">
        <span className="bot-status-label">{group.label}</span>
        <span
          className={`badge ${
            stopping ? 'badge-running' : group.running ? 'badge-running' : 'badge-idle'
          }`}
        >
          {stopping ? 'Parando...' : group.running ? 'Rodando' : 'Parado'}
        </span>
        {!commandsOn && (
          <span className="badge badge-idle" title="Comandos WhatsApp desativados neste grupo">
            Comandos off
          </span>
        )}
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {(group.readyActivate?.length ?? 0) === 1
            ? '1 conta pronta'
            : `${group.readyActivate?.length ?? 0} contas prontas`}
        </span>
      </div>
      {!group.running && !stopping ? (
        <button
          type="button"
          className="btn btn-primary"
          style={{ padding: '8px 16px', fontSize: '0.85rem' }}
          disabled={!commandsOn}
          title={commandsOn ? undefined : 'Ative os comandos em Grupos WhatsApp'}
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
  );
}

function TerminalLogs({
  groupId,
  running,
}: {
  groupId: string;
  running: boolean;
}) {
  const [logs, setLogs] = useState<{ line: string; stream: string }[]>([]);

  useEffect(() => {
    setLogs([]);
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
          Logs {running && <span className="badge badge-running">ao vivo</span>}
        </p>
      </div>
      <div className="activity-panel-body">
        <LogTerminal
          logs={logs}
          emptyMessage="Nenhum log ainda. Inicie o bot acima."
        />
      </div>
    </div>
  );
}

function GenerateActivityTab({
  running,
  count,
  accounts,
  onRefresh,
}: {
  running: boolean;
  count: number;
  accounts: ReadyAccount[];
  onRefresh: () => void;
}) {
  const [logs, setLogs] = useState<{ line: string; stream: string }[]>([]);

  useEffect(() => {
    setLogs([]);
    const disconnect = connectBotLogs('generate', (entry) => {
      setLogs((prev) => [
        ...prev.slice(-499),
        { line: entry.line, stream: entry.stream },
      ]);
    });
    return disconnect;
  }, []);

  return (
    <div className="dashboard-activity-tab">
      <p className="dashboard-activity-subtitle">{count} conta(s) gerada(s) hoje</p>
      <div className="activity-split">
        <div className="activity-panel">
          <div className="activity-panel-header">
            <p className="card-title" style={{ margin: 0 }}>
              Logs {running && <span className="badge badge-running">ao vivo</span>}
            </p>
          </div>
          <div className="activity-panel-body">
            <LogTerminal logs={logs} emptyMessage="Nenhum log ainda." />
          </div>
        </div>
        <ReadyAccountsPanel
          kind="generate"
          accounts={accounts}
          accountsLabel="Contas geradas"
          onReleased={onRefresh}
        />
      </div>
    </div>
  );
}

function ResumoTab({
  groups,
  onReset,
  onToggleCommands,
  togglingId,
}: {
  groups: GroupSummary[];
  onReset: (groupId: string) => void;
  onToggleCommands: (groupId: string, enabled: boolean) => void;
  togglingId: string | null;
}) {
  if (!groups.length) {
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        Nenhum grupo cadastrado. Adicione grupos em &quot;Grupos WhatsApp&quot;.
      </p>
    );
  }

  return (
    <div className="grid-2" style={{ gap: 12 }}>
      {groups.map((g) => (
        <div key={g.id} className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <p className="card-title" style={{ margin: 0 }}>
                {g.label}
              </p>
              <span className={`badge ${g.running ? 'badge-running' : 'badge-idle'}`}>
                {g.running ? 'Bot rodando' : 'Bot parado'}
              </span>
              {g.enabled === false && (
                <span className="badge badge-idle" style={{ marginLeft: 6 }}>
                  Comandos off
                </span>
              )}
            </div>
            <div className="card-actions">
              <button
                type="button"
                className={`btn btn-sm ${g.enabled !== false ? 'btn-danger' : 'btn-primary'}`}
                disabled={togglingId === g.id}
                title={
                  g.enabled !== false
                    ? 'Para de receber /start /stop /status /count'
                    : 'Reativar comandos WhatsApp neste grupo'
                }
                onClick={() => onToggleCommands(g.id, g.enabled === false)}
              >
                {togglingId === g.id
                  ? 'Salvando...'
                  : g.enabled !== false
                    ? 'Desativar'
                    : 'Ativar'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onReset(g.id)}
              >
                Zerar marcador
              </button>
            </div>
          </div>
          <div className="grid-2" style={{ marginTop: 16, gap: 8 }}>
            <div>
              <div className="metric-value" style={{ fontSize: '1.5rem' }}>
                {g.activatedCount}
              </div>
              <div className="metric-label">PIX ativados</div>
            </div>
            <div>
              <div className="metric-value" style={{ fontSize: '1.5rem' }}>
                {g.activatedToday}
              </div>
              <div className="metric-label">Ativadas hoje</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('resumo');
  const [stoppingGroup, setStoppingGroup] = useState<string | null>(null);
  const [stoppingGenerate, setStoppingGenerate] = useState(false);
  const [togglingCommandsId, setTogglingCommandsId] = useState<string | null>(null);
  const [logGroupId, setLogGroupId] = useState<string | null>(null);
  const [readyGroupId, setReadyGroupId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.dashboard().then(setData).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const groups: GroupSummary[] = data?.groups || [];
    if (!logGroupId && groups.length) {
      setLogGroupId(groups[0].id);
    }
    if (!readyGroupId && groups.length) {
      setReadyGroupId(groups[0].id);
    }
  }, [data, logGroupId, readyGroupId]);

  if (!data) {
    return (
      <div className="header">
        <h2>Dashboard</h2>
        <p>Carregando...</p>
      </div>
    );
  }

  const groups: GroupSummary[] = data.groups || [];
  const generateRunning = data.bots?.generate?.running;
  const logGroup = groups.find((g) => g.id === logGroupId) || groups[0];
  const readyGroup = groups.find((g) => g.id === readyGroupId) || groups[0];

  const handleStartGenerate = async () => {
    try {
      const opts = botPrefs.loadGenerate();
      await persistConcurrency(opts.concurrency);
      await api.startGenerate(opts);
      refresh();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleStopGenerate = async () => {
    setStoppingGenerate(true);
    try {
      await api.stopBot('generate');
      refresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setStoppingGenerate(false);
    }
  };

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

      <div className="card dashboard-activity">
        <div className="tabs">
          <button
            type="button"
            className={`tab${tab === 'resumo' ? ' active' : ''}`}
            onClick={() => setTab('resumo')}
          >
            Resumo
          </button>
          <button
            type="button"
            className={`tab${tab === 'ativador' ? ' active' : ''}`}
            onClick={() => setTab('ativador')}
          >
            Ativador
          </button>
          <button
            type="button"
            className={`tab${tab === 'gerador' ? ' active' : ''}`}
            onClick={() => setTab('gerador')}
          >
            Gerador
          </button>
        </div>

        <div className="dashboard-activity-body">
          {tab === 'resumo' && (
            <ResumoTab
              groups={groups}
              onReset={handleResetStats}
              onToggleCommands={handleToggleCommands}
              togglingId={togglingCommandsId}
            />
          )}

          {tab === 'gerador' && (
            <>
              <div className="card dashboard-status" style={{ marginBottom: 12 }}>
                <div className="bot-status-row">
                  <div className="bot-status-info">
                    <span className="bot-status-label">Gerar contas</span>
                    <span
                      className={`badge ${generateRunning ? 'badge-running' : 'badge-idle'}`}
                    >
                      {stoppingGenerate ? 'Parando...' : generateRunning ? 'Rodando' : 'Parado'}
                    </span>
                  </div>
                  {!generateRunning && !stoppingGenerate ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ padding: '8px 16px', fontSize: '0.85rem' }}
                      onClick={handleStartGenerate}
                    >
                      Iniciar
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-danger"
                      style={{ padding: '8px 16px', fontSize: '0.85rem' }}
                      disabled={stoppingGenerate}
                      onClick={handleStopGenerate}
                    >
                      {stoppingGenerate ? 'Parando...' : 'Pausar'}
                    </button>
                  )}
                </div>
              </div>
              <GenerateActivityTab
                running={!!generateRunning}
                count={data.generatedToday}
                accounts={data.readyGenerate || []}
                onRefresh={refresh}
              />
            </>
          )}

          {tab === 'ativador' && (
            <div className="dashboard-activity-tab">
              <div className="card dashboard-status dashboard-status--groups">
                <p className="card-title">Ativador por grupo</p>
                {groups.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)' }}>
                    Cadastre grupos em &quot;Grupos WhatsApp&quot;.
                  </p>
                ) : (
                  <div className="bot-status-grid-scroll">
                    <div className="bot-status-grid">
                      {groups.map((g) => (
                        <GroupBotControl
                          key={g.id}
                          group={g}
                          stopping={stoppingGroup === g.id}
                          onStart={() => handleStartActivate(g.id)}
                          onStop={() => handleStopActivate(g.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {logGroup && (
                <>
                  <div className="dashboard-ativador-controls">
                    <label className="header-controls__field" style={{ fontSize: '0.85rem' }}>
                      <span>Logs do grupo:</span>
                      <select
                        className="select select--inline"
                        value={logGroup.id}
                        onChange={(e) => setLogGroupId(e.target.value)}
                      >
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p className="dashboard-activity-subtitle">
                    {logGroup.activatedToday} conta(s) ativada(s) hoje
                  </p>
                  <div className="activity-split dashboard-ativador-split">
                    <TerminalLogs
                      groupId={logGroup.id}
                      running={!!logGroup.running}
                    />
                    <ReadyAccountsPanel
                      kind="activate"
                      accounts={readyGroup?.readyActivate || []}
                      accountsLabel="Contas prontas"
                      groups={groups.map((g) => ({ id: g.id, label: g.label }))}
                      groupId={readyGroup?.id}
                      onGroupChange={setReadyGroupId}
                      onReleased={refresh}
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
