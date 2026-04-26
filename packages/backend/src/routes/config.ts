import { Router } from 'express';
import { getAllProjects } from '../config';

const router = Router();

router.get('/config', (_req, res) => {
  res.json(getAllProjects());
});

export default router;
