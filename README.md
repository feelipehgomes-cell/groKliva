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

Abra o `.env` e ajuste o essencial:

| Variável | O que fazer |
|----------|-------------|
| `PROXY_URL` | Proxy no formato `usuario:senha@host:porta` (ou deixe vazio para testar sem proxy) |
| `WHATSAPP_PHONE_NUMBER` | Seu número com DDI, só dígitos (ex.: `5511999999999`) |
| `SUBSCRIBE_TRIAL` | `true` se quiser ativar o fluxo de trial PIX |
| `PIX_PAYER_NAME` / `PIX_PAYER_CPF` | Fallback de pagador (ou use o arquivo de CPFs abaixo) |

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

A sessão fica em `whatsapp-auth/` (não versionada). Com a KLIVA rodando, comandos no grupo (`/start`, `/stop`, `/status`) também funcionam se `WHATSAPP_COMMANDS_ENABLED=true`.

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
