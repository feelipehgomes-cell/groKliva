import { runGenerateBot, parseGenerateArgs } from './runner.js';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

const args = parseGenerateArgs(process.argv);

runGenerateBot({ args })
  .then(async ({ exitCode, ok }) => {
    if (config.keepBrowserOpen && ok > 0) {
      logger.info('KEEP_BROWSER_OPEN=true -> pressione Ctrl+C para encerrar.');
      await new Promise(() => {});
      return;
    }
    process.exit(exitCode);
  })
  .catch((err) => {
    logger.error('Erro fatal:', err.message);
    logger.error(err.stack);
    process.exit(1);
  });
