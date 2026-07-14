import { Router } from 'express';
import {
  listGroups,
  addGroup,
  removeGroup,
  getGroupById,
  setGroupEnabled,
  patchGroup,
} from '../services/groupStore.js';
import {
  getGroupStats,
  resetGroupStats,
  incrementActivatedCount,
} from '../services/groupStatsStore.js';
import { botManager } from '../services/botManager.js';
import { listBaileysGroups } from '../../bot/shared/whatsapp/whatsappBaileys.js';
import { refreshWhatsAppHub } from '../services/whatsappHub.js';

const router = Router();

const hubLog = {
  info: (msg) => console.log(`[groups] ${msg}`),
  warn: (msg) => console.warn(`[groups] ${msg}`),
  debug: () => {},
};

router.get('/', (_req, res) => {
  const groups = listGroups().map((g) => ({
    ...g,
    stats: getGroupStats(g.id),
    running: botManager.isActivateRunning(g.id),
  }));
  res.json({ groups });
});

router.get('/discover', async (_req, res) => {
  try {
    const discovered = await listBaileysGroups({ log: hubLog });
    const registered = new Set(listGroups().map((g) => g.id));
    const available = discovered
      .filter((g) => !registered.has(g.id))
      .map((g) => ({ id: g.id, label: g.subject, participants: g.participants }));
    res.json({ groups: available });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { id, label } = req.body || {};
    const group = addGroup({ id, label });
    refreshWhatsAppHub().catch(() => {});
    res.json({ ok: true, group });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const groupId = decodeURIComponent(req.params.id);
    if (botManager.isActivateRunning(groupId)) {
      return res.status(400).json({ ok: false, error: 'Bot rodando neste grupo. Pare antes de remover.' });
    }
    const removed = removeGroup(groupId);
    refreshWhatsAppHub().catch(() => {});
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const groupId = decodeURIComponent(req.params.id);
    const { enabled, sendReadyPix } = req.body || {};
    const group = patchGroup(groupId, { enabled, sendReadyPix });
    refreshWhatsAppHub().catch(() => {});
    res.json({ ok: true, group });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/:id/stats', (req, res) => {
  const groupId = decodeURIComponent(req.params.id);
  const group = getGroupById(groupId);
  if (!group) return res.status(404).json({ error: 'Grupo nao encontrado' });
  res.json({ group, stats: getGroupStats(groupId) });
});

router.post('/:id/stats/reset', (req, res) => {
  try {
    const groupId = decodeURIComponent(req.params.id);
    const group = getGroupById(groupId);
    if (!group) return res.status(404).json({ error: 'Grupo nao encontrado' });
    const stats = resetGroupStats(groupId);
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/:id/stats/increment', (req, res) => {
  try {
    const groupId = decodeURIComponent(req.params.id);
    const amount = Number(req.body?.amount) || 1;
    const stats = incrementActivatedCount(groupId, amount);
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

export default router;
