import { useEffect, useState } from 'react';
import { api } from '../api/client';

const EXAMPLE = `00359319904|JUNIOR GOMES
02249123055|MARIA SILVA`;

export function CpfsPage() {
  const [data, setData] = useState<any>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => api.cpfs().then(setData).catch(console.error);

  useEffect(() => {
    load();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.addCpfsText(text);
      setText('');
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ''));
    reader.readAsText(file);
    e.target.value = '';
  };

  const remove = async (cpf: string) => {
    if (!confirm(`Remover CPF ${cpf}?`)) return;
    try {
      await api.deleteCpf(cpf);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const total = data?.totalBlocks ?? 0;
  const preview = data?.preview ?? [];

  return (
    <>
      <div className="header">
        <div>
          <h2>CPFs</h2>
          <p>
            Pool de pagadores PIX — {total} CPF(s) cadastrado(s), {data?.totalSlots ?? 0} vaga(s)
            restante(s)
          </p>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <p className="card-title">Adicionar via .txt</p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0 0 12px' }}>
            Uma linha por pagador no formato <code>cpf|nome</code> ou importe um arquivo .txt
          </p>
          <form onSubmit={submit}>
            <div className="form-row">
              <label>Arquivo .txt (opcional)</label>
              <label className="btn btn-secondary btn-sm btn-file">
                Escolher arquivo
                <input type="file" accept=".txt,text/plain" hidden onChange={onFile} />
              </label>
            </div>
            <div className="form-row">
              <label>Conteudo</label>
              <textarea
                className="textarea"
                rows={14}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={EXAMPLE}
                required
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? 'Adicionando...' : 'Adicionar blocos'}
            </button>
          </form>
        </div>

        <div className="card">
          <p className="card-title">
            Preview ({Math.min(5, total)} de {total})
          </p>
          <div className="activity-list">
            {preview.map((b: any) => (
              <div key={b.cpf} className="activity-item">
                <span className={`badge ${b.remaining > 0 ? 'badge-success' : 'badge-warning'}`}>
                  {b.remaining}/{data?.cap} estoque
                </span>
                <div>
                  <div>{b.nome}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{b.cpf}</div>
                </div>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => remove(b.cpf)}
                >
                  Remover
                </button>
              </div>
            ))}
            {!total && <p style={{ color: 'var(--text-muted)' }}>Nenhum CPF cadastrado</p>}
            {total > 5 && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 8 }}>
                + {total - 5} CPF(s) nao exibidos
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
