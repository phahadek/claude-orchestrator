import { NOTION_MCP_SERVER_NAME } from './toolNaming';
import { NOTION_READ_PROXY_FULL_PATH } from '../routes/notionReadProxy';

export { NOTION_MCP_SERVER_NAME };

/**
 * Builds the MCP server entry registered under the `notion` key (see
 * toolNaming.ts#NOTION_MCP_SERVER_NAME) for Notion-task-source projects —
 * merged into a session's MCP config in SessionManager.ts#writeMcpConfig,
 * gated on `project.taskSource === 'notion'`.
 *
 * `@notionhq/notion-mcp-server@2.5.1` reads `BASE_URL` (overriding the
 * OpenAPI spec's servers[0].url; its paths already carry the `/v1` prefix)
 * and `OPENAPI_MCP_HEADERS` (a JSON headers object). The entry points it at
 * the backend's loopback read-only retrying proxy (routes/notionReadProxy.ts)
 * and authenticates with the session's stage credential, so the real Notion
 * key never lands in the per-session MCP config file and a Notion 429 is
 * retried server-side before the session sees it.
 *
 * Read-only by design: the proxy admits only the read surface (see
 * config.ts#NOTION_READ_MCP_TOOLS), and the write verbs the server may also
 * expose are never added to a session's --allowed-tools.
 */
export function buildNotionMcpServerEntry(
  port: number,
  stageToken: string,
): Record<string, unknown> {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server@2.5.1'],
    env: {
      BASE_URL: `http://127.0.0.1:${port}${NOTION_READ_PROXY_FULL_PATH}`,
      OPENAPI_MCP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${stageToken}`,
      }),
    },
  };
}
