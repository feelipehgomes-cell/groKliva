/** Normaliza CPF para 11 digitos. */
export function normalizeCpf(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

/** Formata CPF para digitacao (000.000.000-00). */
export function formatCpfMasked(cpf) {
  const d = normalizeCpf(cpf);
  if (!d) return '';
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export function maskCpf(cpf) {
  const d = normalizeCpf(cpf);
  if (!d) return '***';
  return `***${d.slice(-4)}`;
}
