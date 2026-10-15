import { Router } from 'express';
import type { Request, Response } from 'express';
import { config } from '../config';
import { requireSessionStageAuth } from '../auth/SessionStageAuth';
import {
  fetchWithNotionRetry,
  type NotionRetryOptions,
} from '../notion/notionFetchRetry';

const NOTION_READ_PROXY_PATH = '/notion-proxy';
export const NOTION_READ_PROXY_FULL_PATH = `/api${NOTION_READ_PROXY_PATH}`;

const NOTION_UPSTREAM = 'https://api.notion.com';
const DEFAULT_NOTION_VERSION = '2025-09-03';

// Total hold budget across retries — kept below the MCP tool-call timeout so
// the session gets the upstream 429 rather than a transport timeout.
const NOTION_PROXY_TOTAL_BUDGET_MS = 45_000;

// The read surface behind config.ts#NOTION_READ_MCP_TOOLS (paths carry the /v1
// prefix of the notion-mcp-server OpenAPI spec).
const READ_GET_PATHS: RegExp[] = [
  /^\/v1\/users$/,
  /^\/v1\/users\/me$/,
  /^\/v1\/users\/[^/]+$/,
  /^\/v1\/search$/,
  /^\/v1\/comments$/,
  /^\/v1\/blocks\/[^/]+$/,
  /^\/v1\/blocks\/[^/]+\/children$/,
  /^\/v1\/pages\/[^/]+$/,
  /^\/v1\/pages\/[^/]+\/markdown$/,
  /^\/v1\/pages\/[^/]+\/properties\/[^/]+$/,
  /^\/v1\/data_sources\/[^/]+$/,
  /^\/v1\/data_sources\/[^/]+\/templates$/,
  /^\/v1\/databases\/[^/]+$/,
];
const READ_POST_PATHS: RegExp[] = [
  /^\/v1\/search$/,
  /^\/v1\/data_sources\/[^/]+\/query$/,
  /^\/v1\/databases\/[^/]+\/query$/,
];

function isNotionReadAllowed(method: string, path: string): boolean {
  const patterns =
    method === 'GET'
      ? READ_GET_PATHS
      : method === 'POST'
        ? READ_POST_PATHS
        : [];
  return patterns.some((re) => re.test(path));
}

/**
 * Loopback-only, read-only Notion proxy for the per-session
 * @notionhq/notion-mcp-server (pointed here via its BASE_URL env). Authed by
 * the session's stage credential; substitutes the real Notion key server-side
 * and forwards through the shared bounded 429 retry, so a raw rate_limited
 * envelope only reaches a session after retry exhaustion.
 */
export function createNotionReadProxyRouter(
  retryOpts: NotionRetryOptions = {},
): Router {
  const router = Router();

  router.use(
    NOTION_READ_PROXY_PATH,
    requireSessionStageAuth,
    async (req: Request, res: Response) => {
      const upstreamPath = req.path;
      if (!isNotionReadAllowed(req.method, upstreamPath)) {
        res.status(403).json({
          error: 'forbidden',
          code: 'notion_proxy_read_only',
        });
        return;
      }

      const qIdx = req.originalUrl.indexOf('?');
      const query = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
      const notionVersion = req.headers['notion-version'];
      const init: RequestInit = {
        method: req.method,
        headers: {
          Authorization: `Bearer ${config.notionApiKey}`,
          'Notion-Version':
            typeof notionVersion === 'string'
              ? notionVersion
              : DEFAULT_NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body:
          req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
      };

      try {
        const { response } = await fetchWithNotionRetry(
          `${NOTION_UPSTREAM}${upstreamPath}${query}`,
          init,
          { totalBudgetMs: NOTION_PROXY_TOTAL_BUDGET_MS, ...retryOpts },
        );
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        res
          .status(response.status)
          .type(response.headers.get('Content-Type') ?? 'application/json')
          .send(await response.text());
      } catch {
        res.status(502).json({
          error: 'bad_gateway',
          code: 'notion_upstream_unreachable',
        });
      }
    },
  );

  return router;
}
