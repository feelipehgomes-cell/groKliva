# groKliva / KLIVA

Automação Grok (login, trial PIX + WhatsApp) com **interface KLIVA** para gerenciar bots, contas, CPFs e configurações.

| Bot | Comando | Função |
|-----|---------|--------|
| **Ativar via PIX** | `npm run activate` | Login + trial PIX + WhatsApp |

---

## Pré-requisitos

- **Node.js 18+** ([nodejs.org](https://nodejs.org))
- **Google Chrome** instalado (o bot usa o Chrome real via Puppeteer)
- Conta GitHub / clone do repositório

---

## Instalação (passo a passo)

### 1. Clonar o repositório

```bash
git clone https://github.com/feelipehgomes-cell/groKliva.git
cd groKliva
```

### 2. Instalar dependências

Na raiz do projeto:

```bash
npm install
```

Depois, na interface:

```bash
cd ui
npm install
cd ..
```

### 3. Criar o arquivo de ambiente

```bash
cp .env.example .env
```

No Windows (PowerShell):

```powershell
Copy-Item .env.example .env
```

Abra o `.env` e preencha só o essencial:

| Variável | O que fazer |
|----------|-------------|
| `KLIVA_LICENSE_KEY` | Chave de licença (release) |
| `PROXY_URL` | Proxy `usuario:senha@host:porta` (vazio = sem proxy) |
| `WHATSAPP_PHONE_NUMBER` | Seu número com DDI, só dígitos (ex.: `5511999999999`) |
| `CONCURRENCY` | Quantos browsers ao mesmo tempo (padrão `1`) |
| `HIDE_WINDOWS` | `true` = janelas fora da tela |
| `PIX_USE_PROXY` | `true` = usar proxy na ativação |

O restante (timeouts, selectors, paths) já tem default no código — não precisa configurar. O bot sempre aguarda confirmação do PIX.

### 4. Preparar pasta e arquivos de dados

Crie a pasta `data` (ela não vai pro Git):

```bash
mkdir data
```

**Contas** — `data/accounts.txt` (formato `email|senha|`):

```
email@dominio.com|senha|
```

Pode copiar o exemplo:

```bash
cp accounts.example.txt data/accounts.txt
```

**CPFs / pagadores** — `data/payer-results.txt` (formato `CPF|NOME`):

```
00359319904|JUNIOR GOMES
02249123055|MARIA SILVA
```

Pode copiar o exemplo:

```bash
cp payer-results.example.txt data/payer-results.txt
```

---

## Como iniciar

Há duas formas: **pela interface KLIVA** (recomendado) ou **só pelo terminal (CLI)**.

### Opção A — Interface KLIVA (recomendado)

**Desenvolvimento** (hot reload na UI + API reinicia sozinha):

```bash
npm run dev:kliva
```

Abra **http://localhost:4000**

Na interface você controla:

- Dashboard
- Bot de ativação (PIX + WhatsApp)
- Contas, CPFs, grupos WhatsApp
- Configurações

**Produção** (build estático servido em `:4000`):

```bash
npm run build:kliva
npm run start:kliva
```

Use `dev:kliva` enquanto edita; use `start:kliva` só depois do build para simular produção.

### Opção B — Só pelo terminal (CLI)

Com o `.env` e `data/accounts.txt` prontos:

**Ativar trial PIX + WhatsApp:**

```bash
npm run activate -- --concurrency=2 --limit=3
```

**Testes úteis:**

```bash
npm run activate -- --no-proxy --headful
node bot/scripts/test-proxy.js
npm run test:modules
```

---

## WhatsApp (login)

Na primeira vez, autentique o Baileys:

```bash
npm run whatsapp:login -- --force --phone=5511999999999
```

Liste grupos:

```bash
npm run whatsapp:groups
```

A sessão fica em `whatsapp-auth/` (não versionada). Com a KLIVA rodando, comandos no grupo (`/start`, `/stop`, `/status`) funcionam pela página WhatsApp da interface.

---

## Arquitetura

```
bot/           # automação (shared/, activate/, scripts/)
server/        # API Express (bots, contas, CPFs, settings)
ui/            # React + Vite (interface KLIVA)
data/          # runtime (accounts.txt, results.json, CPFs — gitignored)
```

```
bot/
  shared/          config, browser, grok, pix, accounts, whatsapp, proxy
  activate/        bot ativação PIX (cli.js, runner.js, worker.js)
  scripts/         probes e WhatsApp login
```

---

## Resultados (`data/results.json`)

Campos extras na ativação PIX:

```json
{
  "pixSubscribed": true,
  "pixCopyPaste": "000201...",
  "paymentConfirmed": true,
  "paidCount": 12
}
```

---

## Distribuição e licenças (vendedor)

Use este fluxo para **vender o KLIVA sem entregar o código-fonte**. O comprador recebe um ZIP pronto (`iniciar.bat` + interface), não o repositório Git.

### Visão geral

```
Seu .env (LICENSE_SIGNING_SECRET)
        ↓
npm run release          →  kliva-vX.Y.Z.zip  (sem bot/, server/, ui/src/)
        ↓
npm run license:generate →  KLIVA.xxx.yyy     (uma key por comprador)
        ↓
Envie ZIP + key separada →  cliente cola KLIVA_LICENSE_KEY no .env
```

---

### 1. Configurar o segredo (uma vez)

No **seu** `.env` (nunca envie isso ao comprador):

```env
LICENSE_SIGNING_SECRET=coloque-uma-chave-longa-e-aleatoria-aqui-min-32-chars
```

Regras:

- Use uma string longa e aleatória (ex.: gerada com `openssl rand -hex 32`).
- **O mesmo segredo** deve ser usado ao gerar o release **e** ao gerar as licenças.
- Se você trocar o segredo e gerar um release novo, **todas as keys antigas deixam de funcionar** naquele build.
- Não commite o `.env` — só fica na sua máquina.

---

### 2. Gerar o pacote de venda

Na raiz do projeto:

```bash
npm run release
```

Com versão customizada:

```bash
npm run release -- --version=1.0.3
```

Saída:

| Arquivo | Descrição |
|---------|-----------|
| `dist-release/kliva-v1.0.3/` | Pasta completa do produto |
| `dist-release/kliva-v1.0.3.zip` | **Envie isso ao comprador** |

O ZIP contém:

- `app/` — backend minificado (sem código legível)
- `ui/dist/` — interface buildada
- `node_modules/` — dependências de produção
- `iniciar.bat` / `iniciar.ps1` — atalho para o cliente
- `codigo-ativacao.bat` — cliente obtém o código de ativação (anti-repasse)
- `LEIA-ME.txt` — instruções para o comprador
- `.env.example` — template (sem segredo seu)

**Não envie:** repositório Git, pasta `bot/`, `server/`, `ui/src/`, seu `.env`, `LICENSE_SIGNING_SECRET`.

Requisito do cliente: **Node.js 18+** (recomendado 20 LTS) + Google Chrome.

---

### 3. Gerar licença por comprador

Cada venda = uma key única:

```bash
npm run license:generate -- --email=cliente@email.com --days=365
```

Parâmetros:

| Parâmetro | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `--email=` | Sim | E-mail do comprador (referência interna, fica dentro da key) |
| `--days=` | Não | Validade em dias (padrão: `365`) |
| `--machine-id=` | Não | Código de ativação do **cliente** (anti-repasse — ver abaixo) |

Exemplos:

```bash
# Assinatura mensal (30 dias)
npm run license:generate -- --email=maria@email.com --days=30

# Anual
npm run license:generate -- --email=joao@email.com --days=365

# Anti-repasse — use o código que o CLIENTE te enviou
npm run license:generate -- --email=joao@email.com --days=365 --machine-id=a3f8b2c1d4e5f678

# Testar key expirada
npm run license:generate -- --email=teste-expirado@local --days=-1
```

#### Anti-repasse (1 PC por key)

Existem **dois modos** de licença:

| Modo | Comando | Comportamento |
|------|---------|---------------|
| **Padrão** (rápido) | sem `--machine-id` | Key funciona em **qualquer PC** até expirar |
| **Anti-repasse** | com `--machine-id` | Key funciona **só na instalação do cliente** |

##### Por que o código tem que vir do cliente?

O código de ativação é gravado **dentro da key no momento em que você gera a licença** — não quando o cliente abre o bot.

Se você gerasse a key usando um código **do seu PC** (desenvolvedor), no PC do comprador o código seria **diferente** → a validação **nunca bateria** e o bot mostraria `Licenca vinculada a outra instalacao.`

Por isso o cliente roda `codigo-ativacao.bat` e te envia o código **da instalação dele** antes de você gerar a key.

##### Como o código é gerado

O `codigo-ativacao.bat` produz um código único de 16 caracteres para aquela instalação (ex.: `a3f8b2c1d4e5f678`). Você não precisa saber como ele é calculado — só colar em `--machine-id=`.

##### Fluxo anti-repasse (passo a passo)

```
CLIENTE                              VOCÊ (vendedor)
   │                                      │
   ├─ extrai o ZIP                        │
   ├─ roda codigo-ativacao.bat            │
   ├─ vê: a3f8b2c1d4e5f678                │
   └─ te manda o código ─────────────────►├─ gera a key:
                                            │  npm run license:generate --
                                            │    --email=cliente@email.com
                                            │    --days=365
                                            │    --machine-id=a3f8b2c1d4e5f678
                                            └─ envia KLIVA_LICENSE_KEY pronta
```

1. Cliente extrai o ZIP e roda **`codigo-ativacao.bat`**
2. Aparece um código de 16 caracteres (ex.: `a3f8b2c1d4e5f678`)
3. Cliente te manda esse código (WhatsApp, e-mail, etc.)
4. Você gera a key com `--machine-id=CODIGO_DO_CLIENTE` — **nesse instante** o código entra na key
5. Cliente cola a key no `.env` e usa só naquela instalação

> **Não use** `--machine` sozinho. O script bloqueia e exige `--machine-id` com o código que o cliente te enviou.

##### Quando a validação acontece (no cliente)

A checagem roda **ao iniciar o KLIVA em modo release**:

| Momento | O que valida |
|---------|----------------|
| `iniciar.bat` → servidor sobe | key + assinatura + expiração + código de ativação |
| Cliente inicia o bot de ativação na interface | mesma validação de novo |

Se o código da key ≠ código da instalação atual → o processo **encerra na hora** (antes de Chrome, WhatsApp, etc.).

**Cache de 24h:** após a primeira validação OK, grava `data/.license-cache.json` e não revalida por 24 horas. Para forçar nova checagem, apague esse arquivo.

##### Limitações do anti-repasse

- Não é proteção 100% (software local sempre pode ser contornado por quem souber)
- Cliente que **muda de PC** ou **formata** precisa de key nova (novo `codigo-ativacao.bat`)
- Para máxima velocidade nas vendas, use o modo **padrão** (sem `--machine-id`)

Saída no terminal:

```
KLIVA.eyJ2IjoxLCJlbWFpbCI6... .AssinaturaHMAC...
```

A key também é salva em:

```
dist-release/licenses/cliente@email.com-<timestamp>.txt
```

Envie a key ao comprador **por canal separado** do ZIP (e-mail, WhatsApp, etc.).

---

### 4. O que o comprador faz

**Modo padrão (você já enviou a key):**

1. Extrair o ZIP
2. Copiar `.env.example` → `.env`
3. Colar a licença:

```env
KLIVA_LICENSE_KEY=KLIVA.xxxxx.yyyyy
```

4. Configurar proxy, WhatsApp, etc.
5. Duplo clique em `iniciar.bat`
6. Abrir http://localhost:4000

**Modo anti-repasse (você pediu o código de ativação antes):**

1. Extrair o ZIP
2. Rodar **`codigo-ativacao.bat`** e enviar o código ao vendedor
3. Aguardar a `KLIVA_LICENSE_KEY` que o vendedor gera com esse código
4. Colar no `.env` e seguir os passos acima

---

### 5. Como a validação funciona

A key tem o formato `KLIVA.<dados_codificados>.<assinatura>`. Os dados codificados podem conter:

| Campo | Sempre | Anti-repasse |
|-------|--------|--------------|
| `email` | ✅ | ✅ |
| `exp` (expiração) | ✅ | ✅ |
| `mid` (código de ativação) | ❌ | ✅ (só com `--machine-id`) |

Modo **offline** (padrão): assinatura HMAC com o `LICENSE_SIGNING_SECRET` embarcado no build.

Ao iniciar (release), o KLIVA verifica:

1. formato da key
2. assinatura válida (não foi adulterada)
3. data de expiração
4. `mid`, se existir na key — compara com o código da instalação atual

Mensagens comuns:

| Situação | Mensagem |
|----------|----------|
| Key expirada | `Licenca expirada.` |
| Key de outra instalação | `Licenca vinculada a outra instalacao.` |
| Key inválida/ausente | `Licenca invalida ou ausente.` |
| Key OK | `Licenca valida (email@...) — expira: DD/MM/AAAA` |

**Testar expiração:** gere com `--days=-1`, coloque no `.env` e apague `data/.license-cache.json` antes de testar.

**Compartilhamento:** sem `--machine-id`, a mesma key funciona em vários PCs até expirar. Com `--machine-id`, só na instalação cujo código o cliente te enviou.

---

### 6. Checklist por venda

**Modo padrão (mais rápido):**

- [ ] `LICENSE_SIGNING_SECRET` definido no seu `.env`
- [ ] `npm run release -- --version=X.Y.Z`
- [ ] `npm run license:generate -- --email=... --days=...`
- [ ] Enviar ZIP ao comprador
- [ ] Enviar key separada
- [ ] Confirmar Node 18+ e Chrome no cliente

**Modo anti-repasse (1 PC):**

- [ ] Enviar ZIP ao comprador
- [ ] Cliente roda `codigo-ativacao.bat` e te manda o código
- [ ] `npm run license:generate -- --email=... --days=... --machine-id=CODIGO`
- [ ] Enviar key ao comprador

---

### 7. Atualizar versão vendida

Quando corrigir bugs ou lançar feature:

```bash
npm run release -- --version=1.0.4
```

Licenças geradas com o **mesmo** `LICENSE_SIGNING_SECRET` continuam válidas nos releases novos. Keys antigas só param de funcionar se você mudar o segredo.

---

## Resumo rápido

```bash
git clone https://github.com/feelipehgomes-cell/groKliva.git
cd groKliva
npm install
cd ui && npm install && cd ..
cp .env.example .env          # edite o .env
mkdir data
cp accounts.example.txt data/accounts.txt
cp payer-results.example.txt data/payer-results.txt
npm run dev:kliva             # http://localhost:4000
```
