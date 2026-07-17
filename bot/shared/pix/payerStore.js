import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from '../config.js';
import { formatCpfMasked, normalizeCpf } from '../pix/cpf.js';

let chain = Promise.resolve();

function resultsPath() {
  const rel = config.payerResultsFile || 'payer-results.txt';
  return path.isAbsolute(rel) ? rel : path.join(ROOT_DIR, rel);
}

function statePath() {
  const rel = config.payerResultsStateFile || 'payer-results-state.json';
  return path.isAbsolute(rel) ? rel : path.join(ROOT_DIR, rel);
}

function loadState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const data = JSON.parse(raw);
    return {
      usageByCpf: data.usageByCpf && typeof data.usageByCpf === 'object' ? data.usageByCpf : {},
      byEmail:
        data.byEmail && typeof data.byEmail === 'object'
          ? Object.fromEntries(
              Object.entries(data.byEmail).map(([k, v]) => [String(k).toLowerCase(), String(v)]),
            )
          : {},
    };
  } catch {
    return { usageByCpf: {}, byEmail: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(
    statePath(),
    JSON.stringify({ usageByCpf: state.usageByCpf, byEmail: state.byEmail }, null, 2),
    'utf8',
  );
}

/**
 * Padrao atual: uma linha por pagador no formato `cpf|nome`.
 * Mantem compatibilidade com o formato antigo em blocos (RESULTADO/NOME/CPF).
 * @param {string} raw
 * @returns {Array<{ resultado: string, name: string, cpf: string }>}
 */
export function parsePayerResults(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const out = [];
  const seen = new Set();

  const push = (name, cpfRaw) => {
    const cpf = normalizeCpf(cpfRaw) || String(cpfRaw || '').replace(/\D/g, '');
    const cleanName = String(name || '').trim();
    if (!cpf || !cleanName || seen.has(cpf)) return;
    seen.add(cpf);
    out.push({ resultado: String(out.length + 1), name: cleanName, cpf });
  };

  const chunks = text.split(/\n\s*\n+/);

  for (const chunk of chunks) {
    const lines = chunk
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const pipeLines = lines.filter((l) => l.includes('|'));
    if (pipeLines.length) {
      for (const line of pipeLines) {
        const idx = line.indexOf('|');
        push(line.slice(idx + 1), line.slice(0, idx));
      }
      continue;
    }

    // Formato antigo (blocos): • NOME / • CPF
    const entry = {};
    for (const line of lines) {
      const m = line.match(/^[•*]?\s*([A-Za-zÀ-ÿ_]+)\s*:\s*(.+)$/);
      if (!m) continue;
      const key = m[1].toUpperCase();
      const value = m[2].trim();
      if (key === 'NOME') entry.name = value;
      else if (key === 'CPF') entry.cpf = value;
    }
    if (entry.name && entry.cpf) push(entry.name, entry.cpf);
  }

  return out;
}

function formatBlock(entry) {
  return `${entry.cpf}|${entry.name}`;
}

function readBlocks() {
  try {
    return parsePayerResults(fs.readFileSync(resultsPath(), 'utf8'));
  } catch {
    return [];
  }
}

function writeBlocks(blocks) {
  const body = blocks.map(formatBlock).join('\n');
  fs.writeFileSync(resultsPath(), body ? `${body}\n` : '', 'utf8');
}

function findBlock(blocks, cpf) {
  return blocks.find((b) => b.cpf === cpf);
}

/**
 * Vagas restantes considerando uso atual (1 resultado = ate N contas).
 */
export function summarizePayerResults() {
  const blocks = readBlocks();
  const state = loadState();
  const cap = config.payerAccountsPerResult;

  let slots = 0;
  const details = blocks.map((b) => {
    const used = state.usageByCpf[b.cpf] || 0;
    const remaining = Math.max(0, cap - used);
    slots += remaining;
    return { ...b, used, remaining };
  });

  return { blocks: details, totalSlots: slots, cap };
}

/**
 * Falha se nao houver nenhum pagador com vaga (arquivo vazio ou todos esgotados).
 */
export function assertPayerResultsAvailable() {
  if (!config.payerResultsFile) return;

  const file = resultsPath();
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `Arquivo de pagadores PIX nao encontrado: ${file}\n` +
        'Crie o arquivo com uma linha por pagador no formato cpf|nome (veja payer-results.example.txt).',
    );
  }

  const blocks = parsePayerResults(raw);
  if (!blocks.length) {
    throw new Error(
      `Arquivo de pagadores PIX vazio ou invalido: ${file}\n` +
        'Insira pelo menos uma linha no formato cpf|nome (veja payer-results.example.txt).',
    );
  }

  const { totalSlots } = summarizePayerResults();
  if (totalSlots <= 0) {
    throw new Error(
      `Todos os pagadores PIX em ${file} ja foram usados em ${config.payerAccountsPerResult} contas cada.\n` +
        'Adicione novas linhas cpf|nome antes de rodar o bot.',
    );
  }
}

function pickAndReservePayer(addr, state, blocks) {
  const cap = config.payerAccountsPerResult;

  if (state.byEmail[addr]) {
    const cpf = state.byEmail[addr];
    const block = findBlock(blocks, cpf);
    if (block) {
      return payerFromBlock(block, state.usageByCpf[cpf] || 0, cap);
    }
  }

  if (!blocks.length) {
    throw new Error(
      `Lista de pagadores PIX vazia (${resultsPath()}). ` +
        'Preencha payer-results.txt com linhas cpf|nome antes de continuar.',
    );
  }

  let picked = null;
  for (const block of blocks) {
    const used = state.usageByCpf[block.cpf] || 0;
    if (used < cap) {
      picked = block;
      break;
    }
  }

  if (!picked) {
    throw new Error(
      `Nenhum pagador PIX com vaga (${cap} contas por RESULTADO). ` +
        `Adicione novos dados em ${resultsPath()}.`,
    );
  }

  const nextUse = (state.usageByCpf[picked.cpf] || 0) + 1;
  state.usageByCpf[picked.cpf] = nextUse;
  state.byEmail[addr] = picked.cpf;
  saveState(state);

  if (nextUse >= cap) {
    const remaining = blocks.filter((b) => b.cpf !== picked.cpf);
    writeBlocks(remaining);
    delete state.usageByCpf[picked.cpf];
    saveState(state);
  }

  return payerFromBlock(picked, nextUse, cap);
}

/**
 * Reserva nome/CPF para uma conta (idempotente por email).
 * @param {string} email
 */
export function reservePayerForAccount(email) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) throw new Error('Email da conta ausente para reservar pagador PIX.');

  chain = chain.then(() => {
    const state = loadState();
    const blocks = readBlocks();
    return pickAndReservePayer(addr, state, blocks);
  });

  return chain;
}

/**
 * Remove CPF recusado da lista, limpa reservas e atribui o proximo pagador a conta.
 * @param {string} email
 * @param {string} badCpf
 */
export function discardPayerAndReserveNext(email, badCpf) {
  const addr = String(email || '').trim().toLowerCase();
  const cpf =
    normalizeCpf(badCpf) || String(badCpf || '').replace(/\D/g, '');
  if (!addr) throw new Error('Email da conta ausente para trocar pagador PIX.');
  if (!cpf) throw new Error('CPF invalido para descarte apos recusa.');

  chain = chain.then(() => {
    let blocks = readBlocks().filter((b) => b.cpf !== cpf);
    writeBlocks(blocks);

    const state = loadState();
    delete state.usageByCpf[cpf];
    for (const [em, mapped] of Object.entries(state.byEmail)) {
      if (mapped === cpf || em === addr) delete state.byEmail[em];
    }
    saveState(state);

    if (!blocks.length) {
      throw new Error(
        `Lista de pagadores PIX vazia apos remover CPF recusado (${formatCpfMasked(cpf)}). ` +
          `Adicione novos CPFs em ${resultsPath()}.`,
      );
    }

    return pickAndReservePayer(addr, state, blocks);
  });

  return chain;
}

function payerFromBlock(block, useIndex, cap) {
  return {
    name: block.name,
    cpf: block.cpf,
    cpfMasked: formatCpfMasked(block.cpf),
    resultado: block.resultado,
    payerUseIndex: useIndex,
    payerUseCap: cap,
  };
}
