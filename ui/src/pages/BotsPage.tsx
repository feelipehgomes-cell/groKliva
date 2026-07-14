import { useEffect, useRef, useState } from 'react';
import { api, connectBotLogs } from '../api/client';
import { ConcurrencySlider } from '../components/ConcurrencySlider';
import { LogTerminal } from '../components/LogTerminal';
import { botPrefs, persistActivateOpts, persistConcurrency } from '../utils/botPrefs';

function BotCard({
  name,
  title,
  description,
  fields,
  onStart,
  onStop,
  status,
  otherRunning,
  logGroupId,
}: {
  name: 'generate' | 'activate';
  title: string;
  description: string;
  fields: React.ReactNode;
  onStart: () => void;
  onStop: () => void;
  status: any;
  otherRunning: boolean;
  logGroupId?: string;
}) {
  const [logs, setLogs] = useState<any[]>([]);
  const running = status?.running;

  useEffect(() => {
    const disconnect = connectBotLogs(
      name,
      (entry) => {
        setLogs((prev) => [...prev.slice(-499), entry]);
      },
      name === 'activate' ? logGroupId : undefined,
    );
    return disconnect;
  }, [name, logGroupId]);

  return (
    <div className="card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <div>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <p
            style={{
              margin: '4px 0 0',
              color: 'var(--text-muted)',
              fontSize: '0.85rem',
            }}
          >
            {description}
          </p>
        </div>
        <span className={`badge ${running ? 'badge-running' : 'badge-idle'}`}>
          {running ? 'Rodando' : 'Parado'}
        </span>
      </div>

      {fields}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {!running ? (
          <button
            className="btn btn-primary"
            onClick={onStart}
            disabled={otherRunning}
            title={otherRunning ? 'Pare o outro bot primeiro' : ''}
          >
            Iniciar
          </button>
        ) : (
          <button className="btn btn-danger" onClick={onStop}>
            Pausar
          </button>
        )}
      </div>

      {logs.length > 0 && (
        <LogTerminal logs={logs} className="terminal--compact" />
      )}
      {running && (
        <div className="progress-bar" style={{ marginTop: 12 }}>
          <div
            className="progress-bar-fill"
            style={{ width: '100%', animation: 'pulse 2s infinite' }}
          />
        </div>
      )}
    </div>
  );
}

export function BotsPage() {
  const [status, setStatus] = useState<any>(null);
  const [groups, setGroups] = useState<{ id: string; label: string }[]>([]);
  const [activateGroupId, setActivateGroupId] = useState('');
  const [generateOpts, setGenerateOpts] = useState(() => botPrefs.loadGenerate());
  const [activateOpts, setActivateOpts] = useState(() => botPrefs.loadActivate());
  const [sendReadyPixWa, setSendReadyPixWa] = useState(false);

  const refresh = () => api.botStatus().then(setStatus).catch(console.error);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    api.groups().then((res) => {
      const list = (res.groups || []).map((g: any) => ({ id: g.id, label: g.label }));
      setGroups(list);
      if (list.length && !activateGroupId) setActivateGroupId(list[0].id);
    });
  }, [activateGroupId]);

  useEffect(() => {
    api
      .settings()
      .then((data) => {
        const pixFields = data?.groups?.pix?.fields || [];
        const waFields = data?.groups?.whatsapp?.fields || [];

        const limitField = pixFields.find((f: any) => f.key === 'ACTIVATE_ACCOUNT_LIMIT');
        if (limitField) {
          const n = parseInt(String(limitField.value || '0'), 10);
          if (Number.isFinite(n) && n >= 0) {
            setActivateOpts((prev) => ({ ...prev, limit: n }));
          }
        }

        const sendField = waFields.find(
          (f: any) =>
            f.key === 'WHATSAPP_SEND_READY_PIX_ON_STOP' ||
            f.key === 'WHATSAPP_SEND_GENERATED_ON_STOP',
        );
        if (sendField) {
          const raw = String(sendField.value || 'false').trim().toLowerCase();
          setSendReadyPixWa(['1', 'true', 'yes', 'y', 'on'].includes(raw));
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    botPrefs.saveActivate(activateOpts);
  }, [activateOpts]);

  useEffect(() => {
    botPrefs.saveGenerate(generateOpts);
  }, [generateOpts]);

  const concSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const limitSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleConcurrencySave = (concurrency: number) => {
    if (concSaveTimer.current) clearTimeout(concSaveTimer.current);
    concSaveTimer.current = setTimeout(() => {
      persistConcurrency(concurrency).catch(console.error);
    }, 400);
  };

  const scheduleLimitSave = (limit: number) => {
    if (limitSaveTimer.current) clearTimeout(limitSaveTimer.current);
    limitSaveTimer.current = setTimeout(() => {
      api
        .saveSettings({
          ACTIVATE_ACCOUNT_LIMIT: String(
            Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 0,
          ),
        })
        .catch(console.error);
    }, 400);
  };

  const saveSendReadyPixWa = (enabled: boolean) => {
    setSendReadyPixWa(enabled);
    api
      .saveSettings({ WHATSAPP_SEND_READY_PIX_ON_STOP: enabled ? 'true' : 'false' })
      .catch((err) => {
        console.error(err);
        setSendReadyPixWa(!enabled);
        alert(err.message || 'Falha ao salvar');
      });
  };

  const generateRunning = status?.generate?.running;
  const activateMap = status?.activate || {};
  const selectedActivate = activateGroupId ? activateMap[activateGroupId] : null;
  const activateRunning = !!selectedActivate?.running;
  const anyActivateRunning = status?.anyActivateRunning || Object.values(activateMap).some((s: any) => s?.running);

  useEffect(() => {
    const opts = selectedActivate?.startOptions;
    if (!activateRunning || !opts) return;
    setActivateOpts((prev) => ({
      ...prev,
      limit: opts.limit ?? prev.limit,
    }));
  }, [activateRunning, selectedActivate?.startOptions]);

  useEffect(() => {
    const opts = status?.generate?.startOptions;
    if (!status?.generate?.running || !opts) return;
    setGenerateOpts((prev) => ({
      ...prev,
      count: opts.count ?? prev.count,
    }));
  }, [status?.generate?.running, status?.generate?.startOptions]);

  return (
    <>
      <div className="header">
        <div>
          <h2>Bots</h2>
          <p>Iniciar ou pausar automação</p>
        </div>
      </div>

      <div className="grid-2">
        <BotCard
          name="activate"
          title="Ativar via PIX"
          description="Login + trial PIX + WhatsApp + espera pagamento"
          status={selectedActivate || { running: false }}
          otherRunning={false}
          logGroupId={activateGroupId}
          onStart={async () => {
            if (!activateGroupId) {
              alert('Selecione um grupo');
              return;
            }
            try {
              await persistActivateOpts(activateOpts);
              await api.startActivate({
                groupId: activateGroupId,
                limit: activateOpts.limit,
                concurrency: activateOpts.concurrency,
              });
              refresh();
            } catch (e: any) {
              alert(e.message);
            }
          }}
          onStop={() =>
            api
              .stopActivate(activateGroupId)
              .then(refresh)
              .catch((e) => alert(e.message))
          }
          fields={
            <>
              <div className="form-row">
                <label>Grupo WhatsApp</label>
                <select
                  className="select"
                  value={activateGroupId}
                  onChange={(e) => setActivateGroupId(e.target.value)}
                  disabled={activateRunning}
                >
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Limite de contas (0 = todas)</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={activateOpts.limit}
                  onChange={(e) => {
                    const limit = +e.target.value;
                    setActivateOpts({ ...activateOpts, limit });
                    scheduleLimitSave(limit);
                  }}
                  disabled={activateRunning}
                />
              </div>
              <div className="form-row">
                <label>Enviar só contas desta run no WhatsApp ao parar</label>
                <select
                  className="select"
                  value={sendReadyPixWa ? 'true' : 'false'}
                  onChange={(e) => saveSendReadyPixWa(e.target.value === 'true')}
                  disabled={activateRunning}
                >
                  <option value="true">Sim</option>
                  <option value="false">Não</option>
                </select>
              </div>
              <ConcurrencySlider
                value={activateOpts.concurrency}
                onChange={(concurrency) => {
                  setActivateOpts((prev) => ({ ...prev, concurrency }));
                  scheduleConcurrencySave(concurrency);
                }}
                disabled={activateRunning}
              />
            </>
          }
        />

        <BotCard
          name="generate"
          title="Gerar contas"
          description="Cria contas novas no x.ai via generator.email"
          status={status?.generate}
          otherRunning={anyActivateRunning}
          onStart={async () => {
            try {
              await persistConcurrency(generateOpts.concurrency);
              await api.startGenerate(generateOpts);
              refresh();
            } catch (e: any) {
              alert(e.message);
            }
          }}
          onStop={() =>
            api
              .stopBot('generate')
              .then(refresh)
              .catch((e) => alert(e.message))
          }
          fields={
            <>
              <div className="form-row">
                <label>Quantidade</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={generateOpts.count}
                  onChange={(e) =>
                    setGenerateOpts({ ...generateOpts, count: +e.target.value })
                  }
                  disabled={generateRunning}
                />
              </div>
              <ConcurrencySlider
                value={generateOpts.concurrency}
                onChange={(concurrency) => {
                  setGenerateOpts((prev) => ({ ...prev, concurrency }));
                  scheduleConcurrencySave(concurrency);
                }}
                disabled={generateRunning}
              />
            </>
          }
        />
      </div>
    </>
  );
}
