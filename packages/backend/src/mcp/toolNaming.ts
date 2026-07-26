/**
 * Single source of truth for the model-facing orchestrator MCP tool name.
 * The server registers tools with dotted `kind` names (e.g. `task.create`,
 * see mcp/tools/stageProposalTools.ts), but the Claude Code CLI namespaces
 * and sanitizes dots to underscores when exposing them to the model
 * (`mcp__orchestrator__task_create`, never `mcp__orchestrator__task.create`).
 * Every place that needs the model-facing name — the `--allowed-tools`
 * allow-list (config.ts) and the injected prompt examples
 * (planning/procedureAssembler.ts, gate/gateItemVerifier.ts) — must derive
 * it through this function so they can never drift from what the CLI
 * actually exposes.
 */
export function orchestratorMcpToolName(kind: string): string {
  return `mcp__orchestrator__${kind.replace(/\./g, '_')}`;
}

/**
 * Server key the Notion read MCP server is registered under (see
 * mcp/notionMcpServer.ts#buildNotionMcpServerEntry, merged in
 * SessionManager.ts#writeMcpConfig). The CLI derives a tool's exposed prefix
 * from this key — `mcp__<key>__<toolName>` — so every Notion allow-list entry
 * (config.ts#NOTION_READ_MCP_TOOLS) must be derived through
 * `notionMcpToolName` rather than hand-written, or the allow-list silently
 * fails to match what the CLI actually exposes.
 */
export const NOTION_MCP_SERVER_NAME = 'notion';

/** Single source of truth for the model-facing Notion MCP tool name — see NOTION_MCP_SERVER_NAME. */
export function notionMcpToolName(name: string): string {
  return `mcp__${NOTION_MCP_SERVER_NAME}__${name}`;
}
