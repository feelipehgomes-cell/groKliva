import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.dirname(fileURLToPath(import.meta.url));

process.env.KLIVA_ROOT = root;
process.env.KLIVA_RELEASE = '1';

dotenv.config({ path: path.join(root, '.env'), override: false });

const require = createRequire(import.meta.url);
require('./app/run-server.cjs');
