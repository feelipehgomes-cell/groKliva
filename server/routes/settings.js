import { Router } from 'express';
import { readSettings, writeSettings } from '../services/settingsStore.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(readSettings());
});

router.put('/', (req, res) => {
  try {
    const updates = req.body || {};
    const settings = writeSettings(updates);
    res.json(settings);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
