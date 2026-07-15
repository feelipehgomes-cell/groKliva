import crypto from 'node:crypto';
import os from 'node:os';

const raw = [
  os.hostname(),
  os.userInfo().username,
  os.platform(),
  os.arch(),
].join('|');

const code = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);

console.log('');
console.log('Codigo de ativacao KLIVA:');
console.log(code);
console.log('');
console.log('Envie este codigo ao vendedor para receber sua licenca.');
console.log('');
