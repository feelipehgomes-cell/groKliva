import { Router } from 'express';
import { getDashboard, copyReadyAccounts } from '../services/dataStore.js';
import { botManager } from '../services/botManager.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    ...getDashboard(),
    bots: botManager.getStatus(),
  });
});

router.post('/release-accounts', (req, res) => {
  try {
    const { kind, count, groupId } = req.body || {};
    if (!['activate', 'generate'].includes(kind)) {
      return res.status(400).json({ ok: false, error: 'kind invalido' });
    }
    const parsed =
      count === 'all' || count === 0 || count === null || count === undefined
        ? 0
        : Number(count);
    if (count !== 'all' && count !== 0 && (!Number.isFinite(parsed) || parsed < 1)) {
      return res.status(400).json({ ok: false, error: 'count invalido' });
    }
    const result = copyReadyAccounts(kind, parsed, groupId || null);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

export default router;
