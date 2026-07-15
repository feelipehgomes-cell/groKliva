import { useEffect, useState } from 'react';
import { api } from '../api/client';

export function SettingsPage() {
  const [settings, setSettings] = useState<any>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const flattenEssentials = (data: any) => {
    const flat: Record<string, string> = {};
    const essentials = data?.groups?.essentials;
    for (const field of essentials?.fields || []) {
      flat[field.key] = field.value ?? '';
    }
    return flat;
  };

  useEffect(() => {
    api.settings().then((data) => {
      setSettings(data);
      setValues(flattenEssentials(data));
    });
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const data = await api.saveSettings(values);
      setSettings(data);
      setValues(flattenEssentials(data));
      setMessage('Configurações salvas. Reinicie o bot para aplicar.');
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return <div className="header"><h2>Configurações</h2><p>Carregando...</p></div>;

  return (
    <>
      <div className="header">
        <div>
          <h2>Configurações</h2>
          <p>Parâmetros principais do .env</p>
        </div>
      </div>

      <form onSubmit={save}>
        {Object.entries(settings.groups)
          .filter(([id]) => id !== 'whatsapp')
          .map(([id, group]: [string, any]) => (
          <div key={id} className="card settings-section">
            <h3>{group.label}</h3>
            <div className="grid-2">
              {group.fields.map((field: any) => (
                <div
                  key={field.key}
                  className="form-row"
                  style={field.type === 'select' && group.fields.length === 1 ? { gridColumn: '1 / -1' } : undefined}
                >
                  <label>{field.label}</label>
                  {field.type === 'select' ? (
                    <select
                      className="select"
                      value={values[field.key] || field.options?.[0]?.value || ''}
                      onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                    >
                      {(field.options || []).map((opt: any) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'boolean' ? (
                    <select
                      className="select"
                      value={values[field.key] || 'false'}
                      onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                    >
                      <option value="true">Sim</option>
                      <option value="false">Não</option>
                    </select>
                  ) : (
                    <input
                      className="input"
                      type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                      value={values[field.key] ?? ''}
                      onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Salvando...' : 'Salvar configurações'}
          </button>
          {message && <span style={{ color: 'var(--text-muted)' }}>{message}</span>}
        </div>
      </form>
    </>
  );
}
