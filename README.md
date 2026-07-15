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
| `--machine` | Não | Vincula a key ao PC onde o comando roda (anti-repasse) |

Exemplos:

```bash
# Assinatura mensal (30 dias)
npm run license:generate -- --email=maria@email.com --days=30

# Anual
npm run license:generate -- --email=joao@email.com --days=365

# Testar key expirada
npm run license:generate -- --email=teste-expirado@local --days=-1
```

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

1. Extrair o ZIP
2. Copiar `.env.example` → `.env`
3. Colar a licença:

```env
KLIVA_LICENSE_KEY=KLIVA.xxxxx.yyyyy
```

4. Configurar proxy, WhatsApp, etc.
5. Duplo clique em `iniciar.bat`
6. Abrir http://localhost:4000

---

### 5. Como a validação funciona

- Modo **offline** (padrão): a key é assinada com HMAC usando o `LICENSE_SIGNING_SECRET` embarcado no build.
- Ao iniciar, o KLIVA verifica:
  - formato da key (`KLIVA.<payload>.<assinatura>`)
  - assinatura válida
  - data de expiração (`exp`)
  - vínculo de máquina (`mid`), se gerada com `--machine`
- Cache local: após validar, grava `data/.license-cache.json` por **24 horas** (evita revalidar a cada restart).
- Key expirada → bot bloqueia com `[KLIVA] Licenca expirada.`
- Key ausente/inválida → `[KLIVA] Licenca invalida ou ausente.`

**Testar expiração:** gere com `--days=-1`, coloque no `.env` e apague `data/.license-cache.json` antes de testar.

**Compartilhamento:** no modo padrão (sem `--machine`), a mesma key funciona em vários PCs até expirar. Para limitar a 1 máquina, use `--machine`.

---

### 6. Checklist por venda

- [ ] `LICENSE_SIGNING_SECRET` definido no seu `.env`
- [ ] `npm run release -- --version=X.Y.Z`
- [ ] `npm run license:generate -- --email=... --days=...`
- [ ] Enviar ZIP ao comprador
- [ ] Enviar key separada
- [ ] Confirmar que o cliente instalou Node 18+ e Chrome

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
