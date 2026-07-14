# grokPix / KLIVA

Automação Grok (login, gerar contas, trial PIX + WhatsApp) com **interface KLIVA** para gerenciar bots, contas, CPFs e configurações.

## Interface KLIVA

Dashboard dark/roxo para controlar os dois bots:

| Bot | Comando | Função |
|-----|---------|--------|
| **Gerar contas** | `npm run generate` | Cria contas no x.ai |
| **Ativar via PIX** | `npm run activate` | Login + trial PIX + WhatsApp |

```bash
npm install
cd ui && npm install && cd ..
cp .env.example .env
# edite .env

# Desenvolvimento (hot reload na UI + API reinicia sozinha)
npm run dev:kliva
# Abra http://localhost:4000 — alterações na UI aparecem na hora (F5 se precisar)

# Produção (build estático servido em :4000)
npm run build:kliva
npm run start:kliva
```

Abra **http://localhost:4000** nos dois modos. Use `dev:kliva` enquanto edita; use `start:kliva` só após o build para testar produção.

### Arquitetura

```
bot/           # automação (shared/, generate/, activate/, scripts/)
server/        # API Express (bots, contas, CPFs, settings)
ui/            # React + Vite (interface KLIVA)
data/          # runtime (accounts.txt, results.json, CPFs — gitignored)
```

## Setup CLI

```bash
npm install
cp .env.example .env
# edite .env (PROXY_URL, data/accounts.txt, PIX, WhatsApp)
npm run activate
```

## Contas (`data/accounts.txt`)

```
email@dominio.com|senha|
```

Formato estendido (futuro — nome/CPF por conta):

```
email@dominio.com|senha|NOME COMPLETO|00000000000
```

## CLI

```bash
npm run activate -- --limit=3 --concurrency=2
npm run activate -- --no-proxy --headful
npm run generate -- --count=5 --concurrency=2
node bot/scripts/test-proxy.js
node bot/scripts/probe-subscribe.js
npm run test:modules
```

## Gerar contas novas (`npm run generate`)

Cria contas novas no x.ai automaticamente, usando **generator.email** como inbox descartavel para capturar o codigo OTP de verificacao.

```bash
npm run generate -- --count=5 --concurrency=2
```

Detalhes em `data/generated-results.json`. Contas salvas em `data/accounts.txt`.

## Fluxo trial PIX + WhatsApp

```bash
npm run activate -- --concurrency=2 --limit=3
```

Requer CPFs em `data/payer-results.txt` ou `PIX_PAYER_NAME`/`PIX_PAYER_CPF` no `.env`.

## WhatsApp (Baileys)

```bash
npm run whatsapp:login -- --force --phone=5511999999999
npm run whatsapp:groups
```

## Estrutura do bot

```
bot/
  shared/          config, browser, grok, pix, accounts, whatsapp, proxy
  generate/        bot gerador (cli.js, runner.js, worker.js)
  activate/        bot ativacao PIX (cli.js, runner.js, worker.js)
  scripts/         probes e whatsapp login
```

## Resultados (`data/results.json`)

Campos extras na ativacao PIX:

```json
{
  "pixSubscribed": true,
  "pixCopyPaste": "000201...",
  "paymentConfirmed": true,
  "paidCount": 12
}
```
