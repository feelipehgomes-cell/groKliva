import { runActivateBot, parseActivateArgs } from './runner.js';
import { logger } from '../shared/logger.js';
import { isReleaseBuild } from '../shared/releasePaths.js';
import { assertLicenseOrExit } from '../shared/license.js';

async function main() {
  if (isReleaseBuild()) {
    await assertLicenseOrExit();
  }

  const args = parseActivateArgs(process.argv);

  const { exitCode = 0, keepOpen } = await runActivateBot({ args });
  if (!keepOpen) process.exit(exitCode);
}

main().catch((err) => {
  logger.error('Erro fatal:', err.message);
  logger.error(err.stack);
  process.exit(1);
});
