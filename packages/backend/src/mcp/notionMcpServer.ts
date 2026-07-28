import { NOTION_MCP_SERVER_NAME } from './toolNaming';

export { NOTION_MCP_SERVER_NAME };

/**
 * Builds the MCP server entry registered under the `notion` key (see
 * toolNaming.ts#NOTION_MCP_SERVER_NAME) for Notion-task-source projects —
 * merged into a session's MCP config in SessionManager.ts#writeMcpConfig,
 * gated on `project.taskSource === 'notion'`.
 *
 * `@notionhq/notion-mcp-server@2.5.1` resolves its auth header from
 * `OPENAPI_MCP_HEADERS` (a JSON headers object), falling back to
 * `NOTION_TOKEN` (rendered as `Authorization: Bearer <token>`), and returns
 * an empty header object — i.e. every call 401s — when neither is set (see
 * its bundled bin/cli.mjs and its own --help output). `NOTION_API_KEY` is
 * not a variable that package reads at all.
 *
 * The resolved key is inlined directly rather than passed as a `${VAR}`
 * placeholder: writeMcpConfig serialises this entry into a per-session file
 * under the project checkout, already written mode 0o600 and already
 * carrying the orchestrator stage credential (see
 * buildOrchestratorMcpServerEntry), so this is consistent with that file's
 * existing sensitivity handling and not a new risk category.
 *
 * Read-only by design: the registered server exposes only the search/fetch/
 * get/query surface (see config.ts#NOTION_READ_MCP_TOOLS) — the write verbs
 * (create-pages, update-page, move-pages, ...) it may also expose are never
 * added to a session's --allowed-tools, so they're structurally denied even
 * though the underlying integration token grants write.
 */
export function buildNotionMcpServerEntry(
  apiKey: string,
): Record<string, unknown> {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server@2.5.1'],
    env: { NOTION_TOKEN: apiKey },
  };
}
