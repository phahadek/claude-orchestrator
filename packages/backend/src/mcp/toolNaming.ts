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
