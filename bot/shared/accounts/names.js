import { randomInt } from 'node:crypto';

const FIRST_NAMES = [
  'Lucas', 'Gabriel', 'Mateus', 'Rafael', 'Bruno', 'Felipe', 'Gustavo', 'Thiago',
  'Leonardo', 'Daniel', 'Vinicius', 'Andre', 'Rodrigo', 'Marcelo', 'Fernando',
  'Ana', 'Beatriz', 'Camila', 'Juliana', 'Larissa', 'Mariana', 'Amanda', 'Carolina',
  'Fernanda', 'Patricia', 'Vanessa', 'Isabela', 'Leticia', 'Natalia', 'Bianca',
  'Pedro', 'Joao', 'Guilherme', 'Eduardo', 'Ricardo', 'Henrique', 'Diego', 'Caio',
];

const LAST_NAMES = [
  'Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira',
  'Lima', 'Gomes', 'Costa', 'Ribeiro', 'Martins', 'Carvalho', 'Almeida', 'Lopes',
  'Soares', 'Fernandes', 'Vieira', 'Barbosa', 'Rocha', 'Dias', 'Nascimento', 'Andrade',
  'Moreira', 'Nunes', 'Marques', 'Machado', 'Mendes', 'Freitas', 'Cardoso', 'Ramos',
];

function pick(list) {
  return list[randomInt(list.length)];
}

/**
 * Gera um nome ficticio (nome + sobrenome).
 * Respeita SIGNUP_FIRST_NAME / SIGNUP_LAST_NAME do .env se definidos.
 */
export function generateFakeName({ firstName = '', lastName = '' } = {}) {
  return {
    firstName: firstName || pick(FIRST_NAMES),
    lastName: lastName || pick(LAST_NAMES),
  };
}
