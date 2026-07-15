import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../../bot/shared/config.js";

const ENV_PATH = path.join(ROOT_DIR, ".env");

/** Schema minimo: so o que o usuario leigo precisa ajustar. */
export const SETTINGS_SCHEMA = {
  essentials: {
    label: "Essencial",
    fields: [
      { key: "PROXY_URL", type: "text", label: "URL da proxy" },
      {
        key: "PIX_USE_PROXY",
        type: "boolean",
        label: "Usar proxy",
        default: "true",
      },
      {
        key: "WHATSAPP_PHONE_NUMBER",
        type: "text",
        label: "WhatsApp (DDI+DDD+numero)",
      },
      {
        key: "CONCURRENCY",
        type: "number",
        label: "Concorrencia",
        default: "1",
      },
      {
        key: "HIDE_WINDOWS",
        type: "boolean",
        label: "Janelas fora da tela",
        default: "false",
      },
    ],
  },
  // Usado pela pagina WhatsApp (nao aparece como "avancado" no .env.example)
  whatsapp: {
    label: "WhatsApp",
    fields: [
      {
        key: "WHATSAPP_ENABLED",
        type: "boolean",
        label: "WhatsApp ativo",
        default: "true",
      },
      {
        key: "WHATSAPP_SEND_READY_PIX_ON_STOP",
        type: "boolean",
        label: "Enviar contas prontas ao parar (CLI)",
        default: "false",
      },
      {
        key: "WHATSAPP_COMMANDS_ENABLED",
        type: "boolean",
        label: "Comandos /start /stop no grupo",
        default: "true",
      },
      {
        key: "WHATSAPP_COMMANDS_PUBLIC",
        type: "boolean",
        label: "Qualquer um no grupo pode controlar",
        default: "true",
      },
      {
        key: "WHATSAPP_ADMIN_PHONES",
        type: "text",
        label: "Admins WhatsApp (virgula)",
        default: "",
      },
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
        const raw = envMap.get(field.key);
        const value =
          raw !== undefined && raw !== ""
            ? raw
            : (field.default ?? "");
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
