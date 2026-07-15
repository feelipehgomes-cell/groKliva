import { Router } from 'express';
import {
  listAccounts,
  addAccountsFromText,
  deleteAccount,
  getActivationResults,
} from '../services/dataStore.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(listAccounts());
});

router.post('/', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text?.trim()) {
      return res.status(400).json({ error: 'Cole o conteudo do arquivo .txt' });
    }
    const data = await addAccountsFromText(text);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const accounts = await deleteAccount(email);
    res.json(accounts);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/results', (req, res) => {
  const groupId = req.query.groupId || null;
  res.json(getActivationResults(50, groupId));
});

export default router;
