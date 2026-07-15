import { Router } from 'express';
import { botManager } from '../services/botManager.js';

const router = Router();

router.get('/status', (_req, res) => {
  res.json(botManager.getStatus());
});

router.post('/activate/start', async (req, res) => {
  try {
    const result = await botManager.start('activate', req.body || {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/activate/stop', async (req, res) => {
  try {
    const result = await botManager.stop('activate', req.body || {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

function streamLogs(req, res, botName, groupId = null) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const since = parseInt(req.query.since || '0', 10);
  const existing = botManager.getLogs(botName, since, groupId);
  for (const entry of existing) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const onLog = (name, entry, logGroupId) => {
    if (name !== botName) return;
    if (botName === 'activate' && logGroupId !== groupId) return;
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  botManager.on('log', onLog);
  req.on('close', () => {
    botManager.off('log', onLog);
  });
}

router.get('/activate/:groupId/logs', (req, res) => {
  const groupId = decodeURIComponent(req.params.groupId);
  streamLogs(req, res, 'activate', groupId);
});

export default router;
