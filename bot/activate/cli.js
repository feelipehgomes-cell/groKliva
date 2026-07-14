import { runActivateBot, parseActivateArgs } from './runner.js';
import { logger } from '../shared/logger.js';

const args = parseActivateArgs(process.argv);

runActivateBot({ args })
  .then(({ exitCode = 0, keepOpen } = {}) => {
    if (keepOpen) return;
    process.exit(exitCode);
  })
  .catch((err) => {
    logger.error('Erro fatal:', err.message);
    logger.error(err.stack);
    process.exit(1);
  });
