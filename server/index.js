import http from 'node:http';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR } from '../bot/shared/config.js';
import { isReleaseBuild } from '../bot/shared/releasePaths.js';
import { assertLicenseOrExit } from '../bot/shared/license.js';
import botsRouter from './routes/bots.js';
import accountsRouter from './routes/accounts.js';
import cpfsRouter from './routes/cpfs.js';
import settingsRouter from './routes/settings.js';
import dashboardRouter from './routes/dashboard.js';
import whatsappRouter from './routes/whatsapp.js';
import groupsRouter from './routes/groups.js';
import { startWhatsAppHub } from './services/whatsappHub.js';

const app = express();
const PORT = process.env.KLIVA_PORT || 4000;
const isDev = process.env.KLIVA_DEV === '1' && !isReleaseBuild();

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'KLIVA', dev: isDev });
});

app.use('/api/bots', botsRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/cpfs', cpfsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/groups', groupsRouter);

const server = http.createServer(app);

async function setupUi() {
  if (isDev) {
    const viteEntry = path.join(
      ROOT_DIR,
      'ui',
      'node_modules',
      'vite',
      'dist',
      'node',
      'index.js',
    );
    const { createServer: createViteServer } = await import(
      pathToFileURL(viteEntry).href
    );
    const vite = await createViteServer({
      root: path.join(ROOT_DIR, 'ui'),
      configFile: path.join(ROOT_DIR, 'ui', 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: { server },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    return;
  }

  const uiDist = path.join(ROOT_DIR, 'ui', 'dist');
  app.use(express.static(uiDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(uiDist, 'index.html'), (err) => {
      if (err) next();
    });
  });
}

async function main() {
  if (isReleaseBuild()) {
    await assertLicenseOrExit();
  }

  await setupUi();

  server.listen(PORT, () => {
    if (isDev) {
      console.log(`KLIVA dev http://localhost:${PORT} (hot reload ativo)`);
    } else {
      console.log(`KLIVA server http://localhost:${PORT}`);
    }
    startWhatsAppHub().catch((err) => {
      console.warn('[whatsapp-hub] nao iniciado:', err.message);
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
