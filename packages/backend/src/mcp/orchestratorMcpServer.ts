import { Router } from 'express';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireSessionStageAuth } from '../auth/SessionStageAuth';

/** Path the router registers, relative to where it's mounted (see server.ts: app.use('/api', ...)). */
const ORCHESTRATOR_MCP_PATH = '/mcp';

/** Full path as reachable from the backend root, for building the session's MCP config URL. */
const ORCHESTRATOR_MCP_FULL_PATH = `/api${ORCHESTRATOR_MCP_PATH}`;

/** Name of the MCP server entry injected into a dispatched session's config. */
export const ORCHESTRATOR_MCP_SERVER_NAME = 'orchestrator';

/**
 * Builds the `{ type, url, headers }` entry injected into a dispatched
 * session's MCP config, carrying its per-session stage credential as the
 * bearer token. See writeMcpConfig in SessionManager.ts for the merge with
 * per-project mcp_servers.
 */
export function buildOrchestratorMcpServerEntry(
  port: number,
  stageToken: string,
): Record<string, unknown> {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}${ORCHESTRATOR_MCP_FULL_PATH}`,
    headers: { Authorization: `Bearer ${stageToken}` },
  };
}

/**
 * Builds the McpServer instance and registers the minimal handshake tool.
 * This is the transport foundation only — task-write/verdict tools land in
 * a follow-on task; a health tool is enough to prove connectivity end to
 * end (a dispatched session connects with its injected credential and can
 * list/call tools; a wrong credential is rejected before it ever reaches
 * here).
 */
function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'claude-orchestrator',
    version: '1.0.0',
  });

  server.registerTool(
    'health',
    {
      title: 'Orchestrator health check',
      description:
        'Handshake tool confirming the MCP connection and session credential are valid.',
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
    }),
  );

  return server;
}

/**
 * Long-lived, loopback-only orchestrator MCP server mounted alongside the
 * existing REST routes (e.g. /api/task-intents), ahead of requireDeviceAuth.
 * Auth is the same per-session stage credential as the task-intents stage
 * endpoint (requireSessionStageAuth) — scope is staging + verdict reporting
 * only, never apply. Runs stateless: each request gets its own transport +
 * server instance, so no MCP-level session store is needed on top of the
 * per-session stage credential that already scopes access.
 */
export function createOrchestratorMcpRouter(): Router {
  const router = Router();

  router.post(
    ORCHESTRATOR_MCP_PATH,
    requireSessionStageAuth,
    async (req: Request, res: Response) => {
      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  // Stateless mode has no server-managed session to stream to or tear down.
  router.get(ORCHESTRATOR_MCP_PATH, requireSessionStageAuth, (_req, res) => {
    res.status(405).json({ error: 'method_not_allowed' });
  });
  router.delete(ORCHESTRATOR_MCP_PATH, requireSessionStageAuth, (_req, res) => {
    res.status(405).json({ error: 'method_not_allowed' });
  });

  return router;
}
