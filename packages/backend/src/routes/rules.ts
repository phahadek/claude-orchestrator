import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getAllRules,
  getRuleById,
  insertRuleReturning,
  updateRule,
  deleteRule,
} from '../db/queries';
import type { MatchType, RuleDecision } from '../db/types';

export const rulesRouter = Router();

// GET /api/rules
rulesRouter.get('/', (_req: Request, res: Response) => {
  const rules = getAllRules();
  res.json(rules);
});

// POST /api/rules
rulesRouter.post('/', (req: Request, res: Response) => {
  const { pattern, match_type, decision, label, enabled } = req.body as {
    pattern?: string;
    match_type?: string;
    decision?: string;
    label?: string | null;
    enabled?: number;
  };

  if (!pattern || !match_type || !decision) {
    res.status(400).json({ error: 'pattern, match_type, and decision are required' });
    return;
  }
  if (!['glob', 'regex'].includes(match_type)) {
    res.status(400).json({ error: 'match_type must be glob or regex' });
    return;
  }
  if (!['allow', 'deny'].includes(decision)) {
    res.status(400).json({ error: 'decision must be allow or deny' });
    return;
  }

  const rule = insertRuleReturning({
    pattern,
    match_type: match_type as MatchType,
    decision: decision as RuleDecision,
    label: label ?? null,
    enabled: enabled ?? 1,
  });
  res.status(201).json(rule);
});

// PUT /api/rules/:id
rulesRouter.put('/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }

  const existing = getRuleById(id);
  if (!existing) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }

  const { pattern, match_type, decision, label, enabled } = req.body as {
    pattern?: string;
    match_type?: MatchType;
    decision?: RuleDecision;
    label?: string | null;
    enabled?: number;
  };

  updateRule(id, { pattern, match_type, decision, label, enabled });
  const updated = getRuleById(id)!;
  res.json(updated);
});

// DELETE /api/rules/:id
rulesRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }

  const existing = getRuleById(id);
  if (!existing) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }

  deleteRule(id);
  res.status(204).send();
});
