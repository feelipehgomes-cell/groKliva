import { normalizeCpf, maskCpf } from '../shared/cpf.js';
import { getPayerData } from '../shared/payer.js';
import { parsePayerResults } from '../shared/payerStore.js';
import { config } from '../shared/config.js';

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('OK:', msg);
  }
}

assert(normalizeCpf('003.593.199-04') === '00359319904', 'normalizeCpf mascara');
assert(normalizeCpf('123') === null, 'normalizeCpf invalido');

const payer = await getPayerData({ nome: 'JUNIOR GOMES', cpf: '00359319904' });
assert(payer.name === 'JUNIOR GOMES', 'getPayerData nome');
assert(payer.cpf === '00359319904', 'getPayerData cpf');
assert(maskCpf('00359319904') === '***9904', 'maskCpf');

const sample = `• RESULTADO: 1

• NOME: JUNIOR GOMES
• CPF: 00359319904
• SEXO: M - MASCULINO
• NASCIMENTO: 18/05/1932`;

const parsed = parsePayerResults(sample);
assert(parsed.length === 1, 'parsePayerResults count');
assert(parsed[0].cpf === '00359319904', 'parsePayerResults cpf');
assert(parsed[0].name === 'JUNIOR GOMES', 'parsePayerResults nome');

assert(typeof config.selectors.trialCta === 'string', 'selector trialCta');
assert(typeof config.selectors.pixQrImage === 'string', 'selector pixQrImage');
assert(config.pixWaitMs > 0, 'pixWaitMs');

console.log('\n' + (failed ? `${failed} teste(s) falharam.` : 'Todos os testes passaram.'));
process.exit(failed ? 1 : 0);
