import { config } from '../config.js';
import { normalizeCpf, formatCpfMasked } from '../pix/cpf.js';
import { reservePayerForAccount } from '../pix/payerStore.js';

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
