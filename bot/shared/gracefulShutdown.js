import readline from 'node:readline';
import { logger } from './logger.js';

/**
 * Registra handlers para encerramento gracioso (Ctrl+C, SIGTERM, IPC do botManager).
 * @param {() => void | Promise<void>} handler
 */
export function installGracefulInterrupt(handler) {
  let pending = null;

  const fire = () => {
    if (pending) return pending;
    pending = Promise.resolve()
      .then(() => handler())
      .catch((err) => {
        logger.error(`Erro no encerramento: ${err.message}`);
      });
    return pending;
  };

  if (process.platform === 'win32') {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.on('SIGINT', () => {
      rl.close();
      fire();
    });
  }

  process.on('SIGINT', fire);
  process.on('SIGTERM', fire);

  if (typeof process.send === 'function') {
    process.on('message', (msg) => {
      if (msg?.type === 'graceful-stop') fire();
    });
  }
}
