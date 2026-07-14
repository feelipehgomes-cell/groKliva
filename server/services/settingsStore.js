import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../../bot/shared/config.js";

const ENV_PATH = path.join(ROOT_DIR, ".env");

export const WHATSAPP_GROUPS = [
  { id: "120363428198374994@g.us", label: "grok kliva" },
  { id: "120363428345968335@g.us", label: "ESCANEAR KLIVA" },
  { id: "120363412599585849@g.us", label: "GROK LUCAS" },
];

export const SETTINGS_SCHEMA = {
  proxy: {
    label: "Proxy",
    fields: [
      { key: "PROXY_URL", type: "text", label: "URL da proxy" },
      { key: "GENERATE_USE_PROXY", type: "boolean", label: "Proxy no gerador" },
      { key: "PIX_USE_PROXY", type: "boolean", label: "Proxy na ativacao PIX" },
      { key: "PROXY_STICKY", type: "boolean", label: "Sessao sticky" },
    ],
  },
  execution: {
    label: "Execucao",
    fields: [
      { key: "HIDE_WINDOWS", type: "boolean", label: "Janelas fora da tela" },
      {
        key: "KEEP_BROWSER_OPEN",
        type: "boolean",
        label: "Manter browser aberto",
      },
      {
        key: "INSTANCE_STAGGER_MS",
        type: "number",
        label: "Stagger entre instancias (ms)",
      },
      {
        key: "CONCURRENCY",
        type: "number",
        label: "Concorrencia padrao (max browsers abertos)",
      },
      {
        key: "PROXY_MAX_CONCURRENCY",
        type: "number",
        label: "Limite com proxy (0 = sem limite)",
      },
      {
        key: "PROXY_INSTANCE_STAGGER_MS",
        type: "number",
        label: "Stagger minimo com proxy (ms)",
      },
    ],
  },
  generate: {
    label: "Gerador",
    fields: [
      { key: "GENERATE_COUNT", type: "number", label: "Contas por execucao" },
      {
        key: "SIGNUP_PASSWORD",
        type: "password",
        label: "Senha das contas geradas",
      },
      {
        key: "GENERATOR_EMAIL_DOMAIN",
        type: "text",
        label: "Dominio fixo (opcional)",
      },
      {
        key: "GENERATOR_EMAIL_USE_DEFAULT_DOMAINS",
        type: "boolean",
        label: "Usar lista de dominios",
      },
      {
        key: "GENERATOR_EMAIL_DOMAINS",
        type: "text",
        label: "Dominios (virgula)",
      },
      { key: "EMAIL_TIMEOUT_MS", type: "number", label: "Timeout email (ms)" },
    ],
  },
  pix: {
    label: "Ativacao PIX",
    fields: [
      {
        key: "WAIT_FOR_PIX_PAYMENT",
        type: "boolean",
        label: "Aguardar pagamento",
      },
      {
        key: "RELEASE_BROWSER_AFTER_PIX",
        type: "boolean",
        label: "Liberar browser apos PIX (sem confirmar)",
      },
      {
        key: "PIX_POST_SEND_CHECK_MS",
        type: "number",
        label: "Checagem rapida pos-PIX (ms)",
      },
      {
        key: "PAYMENT_WAIT_CYCLE_MS",
        type: "number",
        label: "Ciclo de espera (ms)",
      },
      {
        key: "PAYMENT_WAIT_MAX_CYCLES",
        type: "number",
        label: "Ciclos max aguardando pagamento (0 = infinito)",
      },
      {
        key: "SKIP_PAID_ACCOUNTS",
        type: "boolean",
        label: "Pular contas pagas",
      },
      {
        key: "ACTIVATE_ACCOUNT_LIMIT",
        type: "number",
        label: "Limite de contas (0 = todas)",
      },
    ],
  },
  whatsapp: {
    label: "WhatsApp",
    fields: [
      {
        key: "WHATSAPP_ENABLED",
        type: "boolean",
        label: "WhatsApp ativo",
      },
      {
        key: "WHATSAPP_SEND_READY_PIX_ON_STOP",
        type: "boolean",
        label: "Enviar contas prontas (PIX) no grupo ao parar",
      },
      {
        key: "WHATSAPP_COMMANDS_ENABLED",
        type: "boolean",
        label: "Comandos /start /stop no grupo",
      },
      {
        key: "WHATSAPP_COMMANDS_PUBLIC",
        type: "boolean",
        label: "Qualquer um no grupo pode controlar",
      },
      {
        key: "WHATSAPP_ADMIN_PHONES",
        type: "text",
        label: "Admins WhatsApp (virgula)",
      },
    ],
  },
  files: {
    label: "Arquivos",
    fields: [
      { key: "ACCOUNTS_FILE", type: "text", label: "Arquivo de contas" },
      { key: "RESULTS_FILE", type: "text", label: "Arquivo de resultados" },
    ],
  },
};

function parseEnvFile(content) {
  const map = new Map();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const hash = value.indexOf(" #");
    if (hash >= 0) value = value.slice(0, hash).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

function serializeEnv(content, updates) {
  const lines = content.split(/\r?\n/);
  const updatedKeys = new Set();
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("="))
      return line;
    const key = trimmed.split("=")[0].trim();
    if (updates[key] !== undefined) {
      updatedKeys.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      out.push(`${key}=${value}`);
    }
  }

  return out.join("\n");
}

export function readSettings() {
  let content = "";
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, "utf8");
  }
  const envMap = parseEnvFile(content);
  const groups = {};

  for (const [groupId, group] of Object.entries(SETTINGS_SCHEMA)) {
    groups[groupId] = {
      label: group.label,
      fields: group.fields.map((field) => {
        let value = envMap.get(field.key) ?? "";
        return {
          ...field,
          value,
        };
      }),
    };
  }

  return { groups, rawExists: fs.existsSync(ENV_PATH) };
}

export function writeSettings(updates) {
  const flat = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null) continue;
    flat[key] = String(value);
  }

  let content = "";
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, "utf8");
  } else if (fs.existsSync(path.join(ROOT_DIR, ".env.example"))) {
    content = fs.readFileSync(path.join(ROOT_DIR, ".env.example"), "utf8");
  }

  const next = serializeEnv(content, flat);
  fs.writeFileSync(ENV_PATH, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  return readSettings();
}

export function getEnvMap() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const map = parseEnvFile(fs.readFileSync(ENV_PATH, "utf8"));
  return Object.fromEntries(map);
}
