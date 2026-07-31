import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getOrchestratorConfig,
  getConfigProvenance,
  SECRET_FIELDS,
} from '../config/appConfig';

interface FieldStatus {
  source: 'config.json' | 'env' | 'default';
  value?: unknown;
  present?: boolean;
  length?: number;
}

const FIELD_GETTERS: Record<
  string,
  (c: ReturnType<typeof getOrchestratorConfig>) => unknown
> = {
  'notion.apiKey': (c) => c.notion.apiKey,
  'github.token': (c) => c.github.token,
  'github.repo': (c) => c.github.repo,
  'server.port': (c) => c.server.port,
  'db.path': (c) => c.db.path,
  'sessions.dir': (c) => c.sessions.dir,
  'autoReview.enabled': (c) => c.autoReview.enabled,
  'autoReview.concurrency': (c) => c.autoReview.concurrency,
  setupComplete: (c) => c.setupComplete,
};

/**
 * Reports the effective, resolved orchestrator config with per-field
 * provenance (config.json / .env fallback / shipped default). Secret fields
 * (see SECRET_FIELDS) are reported as presence-and-length only — never the
 * value — so this route's response can never leak a credential.
 */
export function createConfigStatusRouter(): Router {
  const router = Router();

  router.get('/config/status', (_req: Request, res: Response) => {
    const config = getOrchestratorConfig();
    const provenance = getConfigProvenance();

    const fields: Record<string, FieldStatus> = {};
    for (const [key, getter] of Object.entries(FIELD_GETTERS)) {
      const source = provenance[key] ?? 'default';
      const rawValue = getter(config);
      if (SECRET_FIELDS.has(key)) {
        const strValue = typeof rawValue === 'string' ? rawValue : '';
        fields[key] = {
          source,
          present: strValue.length > 0,
          length: strValue.length,
        };
      } else {
        fields[key] = { source, value: rawValue };
      }
    }

    res.json({ fields });
  });

  return router;
}
