import { Router } from 'express';
import { listCpfs, getCpfState, addCpfsFromText, deleteCpf } from '../services/dataStore.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(listCpfs());
});

router.get('/state', (_req, res) => {
  res.json(getCpfState());
});

router.post('/', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text?.trim()) {
      return res.status(400).json({ error: 'Cole o conteudo do arquivo .txt' });
    }
    const data = await addCpfsFromText(text);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:cpf', async (req, res) => {
  try {
    const data = await deleteCpf(decodeURIComponent(req.params.cpf));
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
