import { config } from '../config.js';
import { normalizeCpf, formatCpfMasked } from '../pix/cpf.js';
import {
  discardPayerAndReserveNext,
  reservePayerForAccount,
} from '../pix/payerStore.js';

export { normalizeCpf, formatCpfMasked, maskCpf } from '../pix/cpf.js';

/**
 * Dados do pagador PIX: arquivo payer-results > conta > env global.
 * @param {object} account - { email, nome, cpf, ... }
 */
export async function getPayerData(account = {}) {
  const nameFromAccount = (account.nome || account.name || '').trim();
  const cpfFromAccount = normalizeCpf(account.cpf || account.document);

  if (nameFromAccount && cpfFromAccount) {
    return {
      name: nameFromAccount,
      cpf: cpfFromAccount,
      cpfMasked: formatCpfMasked(cpfFromAccount),
    };
  }

  if (config.payerResultsFile) {
    const email = account.email || account.mail;
    const reserved = await reservePayerForAccount(email);
    return reserved;
  }

  const name = nameFromAccount || config.pixPayerName || '';
  const cpf = cpfFromAccount || normalizeCpf(config.pixPayerCpf);

  if (!name) throw new Error('Nome do pagador PIX ausente (PIX_PAYER_NAME, payer-results.txt ou account.nome).');
  if (!cpf) throw new Error('CPF do pagador PIX invalido (PIX_PAYER_CPF, payer-results.txt ou account.cpf).');

  return { name, cpf, cpfMasked: formatCpfMasked(cpf) };
}

/**
 * Apos Stripe recusar cartao/CPF: remove da lista e reserva o proximo.
 * So funciona com payer-results.txt (nao com CPF fixo na conta/env).
 */
export async function rotatePayerAfterDecline(account = {}, badCpf = '') {
  if (!config.payerResultsFile) {
    throw new Error(
      'Stripe recusou o cartao/CPF, mas nao ha lista de pagadores (PAYER_RESULTS_FILE) para trocar.',
    );
  }
  const email = account.email || account.mail;
  const cpf = badCpf || account.cpf || account.document;
  return discardPayerAndReserveNext(email, cpf);
}
