import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { SwitchToggle } from '../components/SwitchToggle';

type DiscoveredGroup = { id: string; label: string; participants?: number };
type RegisteredGroup = {
  id: string;
  label: string;
  slug: string;
  enabled: boolean;
  sendReadyPix?: boolean;
  stats?: { activatedCount: number };
  running?: boolean;
};

export function GruposPage() {
  const [groups, setGroups] = useState<RegisteredGroup[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [togglingReadyId, setTogglingReadyId] = useState<string | null>(null);

  const load = () => {
    api
      .groups()
      .then((res) => setGroups(res.groups || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const openAdd = async () => {
    setShowAdd(true);
    setDiscovering(true);
    try {
      const res = await api.discoverGroups();
      setDiscovered(res.groups || []);
    } catch (err: any) {
      alert(err.message);
      setDiscovered([]);
    } finally {
      setDiscovering(false);
    }
  };

  const addGroup = async (g: DiscoveredGroup) => {
    try {
      await api.addGroup({ id: g.id, label: g.label });
      setShowAdd(false);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const removeGroup = async (g: RegisteredGroup) => {
    if (!confirm(`Remover grupo "${g.label}"?`)) return;
    try {
      await api.deleteGroup(g.id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const toggleCommands = async (g: RegisteredGroup) => {
    const next = !g.enabled;
    setTogglingId(g.id);
    try {
      await api.setGroupEnabled(g.id, next);
      setGroups((prev) =>
        prev.map((x) => (x.id === g.id ? { ...x, enabled: next } : x)),
      );
    } catch (err: any) {
      alert(err.message);
    } finally {
      setTogglingId(null);
    }
  };

  const toggleSendReadyPix = async (g: RegisteredGroup) => {
    const next = !g.sendReadyPix;
    setTogglingReadyId(g.id);
    try {
      await api.setGroupSendReadyPix(g.id, next);
      setGroups((prev) =>
        prev.map((x) => (x.id === g.id ? { ...x, sendReadyPix: next } : x)),
      );
    } catch (err: any) {
      alert(err.message);
    } finally {
      setTogglingReadyId(null);
    }
  };

  return (
    <>
      <div className="header">
        <div>
          <h2>Grupos WhatsApp</h2>
          <p>Gerencie os grupos onde o ativador PIX opera</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={openAdd}>
          Adicionar grupo
        </button>
      </div>

      {showAdd && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="card-title">Grupos disponíveis na sessão WhatsApp</p>
          {discovering ? (
            <p style={{ color: 'var(--text-muted)' }}>Buscando grupos...</p>
          ) : discovered.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>
              Nenhum grupo novo encontrado. Verifique a sessão em{' '}
              <Link to="/whatsapp">WhatsApp</Link> (conectar por QR).
            </p>
          ) : (
            <ul className="discover-list">
              {discovered.map((g) => (
                <li key={g.id} className="discover-list__item">
                  <div>
                    <strong>{g.label}</strong>
                    <div className="discover-list__meta">
                      {g.id}
                      {g.participants != null ? ` · ${g.participants} membros` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => addGroup(g)}
                  >
                    Adicionar
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 12 }}
            onClick={() => setShowAdd(false)}
          >
            Fechar
          </button>
        </div>
      )}

      <div className="card">
        {loading ? (
          <p>Carregando...</p>
        ) : groups.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>
            Nenhum grupo cadastrado. Clique em &quot;Adicionar grupo&quot;.
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>JID</th>
                <th>Comandos</th>
                <th>Enviar prontas</th>
                <th>Status bot</th>
                <th>Ativadas</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>{g.label}</td>
                  <td className="cell-muted">{g.id}</td>
                  <td>
                    <SwitchToggle
                      checked={g.enabled !== false}
                      disabled={togglingId === g.id}
                      onChange={() => toggleCommands(g)}
                      label={g.enabled !== false ? 'Ativo' : 'Desativado'}
                      title="Quando desligado, /start /stop /status /count sao ignorados"
                    />
                  </td>
                  <td>
                    <SwitchToggle
                      checked={g.sendReadyPix === true}
                      disabled={togglingReadyId === g.id}
                      onChange={() => toggleSendReadyPix(g)}
                      label={g.sendReadyPix ? 'No grupo' : 'No bot'}
                      title={
                        g.sendReadyPix
                          ? 'Ao parar o bot, contas prontas sao enviadas no grupo WhatsApp'
                          : 'Contas prontas ficam no painel do bot para copiar manualmente'
                      }
                    />
                  </td>
                  <td>
                    <span className={`badge ${g.running ? 'badge-running' : 'badge-idle'}`}>
                      {g.running ? 'Rodando' : 'Parado'}
                    </span>
                  </td>
                  <td>{g.stats?.activatedCount ?? 0}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={!!g.running}
                      onClick={() => removeGroup(g)}
                    >
                      Remover
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
