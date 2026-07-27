import { NOTION_MCP_SERVER_NAME } from './toolNaming';

export { NOTION_MCP_SERVER_NAME };

/**
 * Builds the MCP server entry registered under the `notion` key (see
 * toolNaming.ts#NOTION_MCP_SERVER_NAME) for Notion-task-source projects —
 * merged into a session's MCP config in SessionManager.ts#writeMcpConfig,
 * gated on `project.taskSource === 'notion'`.
 *
 * The Notion API key is never inlined here: `${NOTION_API_KEY}` is a literal
 * placeholder string that the CLI expands from its own process env at spawn
 * time (the backend's `NOTION_API_KEY` is already forwarded to the spawned
 * subprocess — see CliSessionRunner#run). writeMcpConfig serialises this
 * entry verbatim into a file under the project checkout, so inlining the
 * real key here would write it to disk in a readable path.
 *
 * Confirmed (not assumed) for the installed CLI (`@anthropic-ai/claude-code`
 * 2.1.220, matching config.claudePath): a server loaded via `--mcp-config
 * <path> --strict-mcp-config` is parsed with `scope:"dynamic"` and
 * `expandVars:true`, and `${VAR}` substitution reads the CLI subprocess's own
 * `process.env` by default — the same code path used for auto-discovered
 * project `.mcp.json` files. A live-session 401 from a Notion MCP tool call
 * is therefore a credential problem (stale/invalid `NOTION_API_KEY` in
 * `packages/backend/.env`), not a templating/delivery bug — see the
 * "Verify/fix Notion MCP credential delivery" investigation.
 *
 * Read-only by design: the registered server exposes only the search/fetch/
 * get/query surface (see config.ts#NOTION_READ_MCP_TOOLS) — the write verbs
 * (create-pages, update-page, move-pages, ...) it may also expose are never
 * added to a session's --allowed-tools, so they're structurally denied even
 * though the underlying integration token grants write.
 */
export function buildNotionMcpServerEntry(): Record<string, unknown> {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server@2.5.1'],
    env: { NOTION_API_KEY: '${NOTION_API_KEY}' },
  };
}
