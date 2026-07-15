import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.js';

export function isReleaseBuild() {
  if (process.env.KLIVA_RELEASE === '1') return true;
  return fs.existsSync(path.join(ROOT_DIR, 'app', 'manifest.json'));
}

export function getActivateScript() {
  if (isReleaseBuild()) {
    return path.join(ROOT_DIR, 'app', 'run-activate.mjs');
  }
  return path.join(ROOT_DIR, 'bot', 'activate', 'cli.js');
}
