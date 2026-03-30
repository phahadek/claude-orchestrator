import { Router } from 'express';
import { config } from '../config';

const router = Router();

router.get('/config', (_req, res) => {
  res.json(config.projects);
});

export default router;
