import { useEffect, useState } from 'react';

import { api } from '../api/client';



const EXAMPLE = `email@dominio.com|senha|

outro@dominio.com|Premium@123|

conta@site.com|MinhaSenha@|Nome Sobrenome`;



export function ContasPage() {

  const [data, setData] = useState<any>(null);

  const [text, setText] = useState('');

  const [showPasswords, setShowPasswords] = useState(false);

  const [saving, setSaving] = useState(false);



  const load = () => {

    api.accounts().then(setData).catch(console.error);

  };



  useEffect(() => {

    load();

  }, []);



  const submit = async (e: React.FormEvent) => {

    e.preventDefault();

    setSaving(true);

    try {

      await api.addAccountsText(text);

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



  const remove = async (email: string) => {
    try {
      await api.deleteAccount(email);

      load();

    } catch (err: any) {

      alert(err.message);

    }

  };



  const total = data?.total ?? 0;

  const preview = data?.preview ?? [];



  return (

    <>

      <div className="header">

        <div>

          <h2>Contas</h2>

          <p>{total} conta(s) na fila global — todos os grupos consomem desta base</p>

        </div>

        <div className="header-controls">

          <label className="toggle-row">

            <input

              type="checkbox"

              checked={showPasswords}

              onChange={(e) => setShowPasswords(e.target.checked)}

            />

            Mostrar senhas

          </label>

        </div>

      </div>



      <div className="grid-2">

        <div className="card">

          <p className="card-title">Adicionar via .txt</p>

          <p className="text-muted" style={{ fontSize: '0.85rem', margin: '0 0 12px' }}>

            Uma conta por linha: <code>email|senha|</code> ou importe um arquivo .txt

          </p>

          <form onSubmit={submit}>

            <div className="form-row">

              <textarea

                className="textarea"

                rows={10}

                value={text}

                onChange={(e) => setText(e.target.value)}

                placeholder={EXAMPLE}

              />

            </div>

            <div className="form-actions">

              <label className="btn btn-secondary btn-sm btn-file">

                Importar .txt

                <input type="file" accept=".txt" hidden onChange={onFile} />

              </label>

              <button

                type="submit"

                className="btn btn-primary btn-sm"

                disabled={saving || !text.trim()}

              >

                {saving ? 'Salvando...' : 'Adicionar'}

              </button>

            </div>

          </form>

        </div>



        <div className="card">

          <p className="card-title">Preview ({total})</p>

          {preview.length === 0 ? (

            <p className="text-muted">Nenhuma conta na fila.</p>

          ) : (

            <ul className="account-list">

              {preview.map((a: any) => (

                <li key={a.email} className="account-list__item">

                  <span className="account-list__email">

                    {a.email}

                    {showPasswords && (

                      <span className="account-list__password">{a.password}</span>

                    )}

                  </span>

                  <button

                    type="button"

                    className="btn btn-danger btn-sm"

                    onClick={() => remove(a.email)}

                  >

                    Remover

                  </button>

                </li>

              ))}

            </ul>

          )}

        </div>

      </div>

    </>

  );

}

