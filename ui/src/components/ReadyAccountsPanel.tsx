import { useState } from 'react';
import { api } from '../api/client';

export type ReadyAccount = { email: string; password: string; credential: string };

const COPY_LIMITS = [
  { value: 'all', label: 'Todas' },
  { value: 5, label: '5' },
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 30, label: '30' },
  { value: 40, label: '40' },
  { value: 50, label: '50' },
] as const;

type ReadyAccountsPanelProps = {
  kind: 'activate';
  accounts: ReadyAccount[];
  accountsLabel: string;
  onReleased: () => void;
  groups?: { id: string; label: string }[];
  groupId?: string;
  onGroupChange?: (groupId: string) => void;
};

export function ReadyAccountsPanel({
  kind,
  accounts,
  accountsLabel,
  onReleased,
  groups,
  groupId,
  onGroupChange,
}: ReadyAccountsPanelProps) {
  const [limit, setLimit] = useState<string | number>('all');
  const [copying, setCopying] = useState(false);
  const [message, setMessage] = useState('');

  const displayText = accounts.map((a) => a.credential).join('\n');

  const handleCopy = async () => {
    setCopying(true);
    setMessage('');
    try {
      const count = limit === 'all' ? 'all' : Number(limit);
      const res = await api.releaseReadyAccounts(
        kind,
        count,
        kind === 'activate' && groupId && groupId !== 'all' ? groupId : undefined,
      );
      await navigator.clipboard.writeText(res.text);
      setMessage(`${res.copied} copiada(s)`);
      onReleased();
      setTimeout(() => setMessage(''), 2500);
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setCopying(false);
    }
  };

  const maxAvailable =
    limit === 'all' ? accounts.length : Math.min(Number(limit), accounts.length);

  return (
    <div className="activity-panel">
      <div className="activity-panel-header ready-accounts-header">
        <p className="card-title ready-accounts-title">
          {accountsLabel} <span className="ready-accounts-count">{accounts.length}</span>
        </p>
        <div className="ready-accounts-toolbar">
          {groups?.length ? (
            <label className="ready-accounts-qty">
              <span className="ready-accounts-qty__label">Grupo</span>
              <select
                className="ready-accounts-qty__select ready-accounts-qty__select--group"
                value={groupId || ''}
                onChange={(e) => onGroupChange?.(e.target.value)}
                disabled={copying}
                aria-label="Grupo das contas prontas"
              >
                <option value="all">Todas</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="ready-accounts-qty">
            <span className="ready-accounts-qty__label">Qtd</span>
            <select
              className="ready-accounts-qty__select"
              value={String(limit)}
              onChange={(e) => {
                const v = e.target.value;
                setLimit(v === 'all' ? 'all' : Number(v));
              }}
              disabled={!accounts.length || copying}
              aria-label="Quantidade para copiar"
            >
              {COPY_LIMITS.map((opt) => (
                <option key={String(opt.value)} value={String(opt.value)}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-primary ready-accounts-copy"
            disabled={!accounts.length || copying}
            onClick={handleCopy}
          >
            {copying ? 'Copiando...' : 'Copiar'}
          </button>
        </div>
      </div>
      <div className="activity-panel-body">
        {message && <p className="ready-accounts-feedback">{message}</p>}
        <textarea
          className="textarea accounts-ready"
          readOnly
          value={displayText}
          placeholder={'Nenhuma conta disponivel.\nFormato: login|senha'}
          onFocus={(e) => e.target.select()}
        />
        {accounts.length > 0 && limit !== 'all' && (
          <p className="ready-accounts-hint">
            Ao copiar, serao liberadas ate {maxAvailable} conta(s) da lista.
          </p>
        )}
      </div>
    </div>
  );
}
