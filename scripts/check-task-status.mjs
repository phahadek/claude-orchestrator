#!/usr/bin/env node
// Claude Code PreToolUse hook: enforce Task Writing Guidelines status rules on
// Notion writes. v1 is create-only enforcement (resolved decision on the M8
// task): block notion-create-pages calls that set Status != "🔲 Backlog";
// notion-update-page calls are always allowed.
//
// Exit 0 = allow. Exit 2 = block (stderr is fed back to the session so it can
// self-correct). Fail-open by design: any parse/shape error exits 0 so
// non-task tool calls are never blocked.
//
// Global location: ~/.claude/scripts/check-task-status.mjs (copy).
// Source: scripts/check-task-status.mjs in the claude-orchestrator repo.

const BACKLOG = '🔲 Backlog';

let raw = '';
try {
  for await (const chunk of process.stdin) raw += chunk;
} catch {
  process.exit(0);
}

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const toolName = typeof input?.tool_name === 'string' ? input.tool_name : '';
const args = input?.tool_input;

if (toolName.endsWith('notion-create-pages')) {
  const pages = Array.isArray(args?.pages) ? args.pages : [];
  for (const p of pages) {
    const status = p?.properties?.Status;
    if (typeof status === 'string' && status.trim() !== '' && status !== BACKLOG) {
      const name =
        p?.properties?.['Task Name'] ?? p?.properties?.title ?? '<untitled>';
      console.error(
        `Task creation blocked: Status='${status}' on page '${name}'. ` +
          `Per the Task Writing Guidelines, new tasks must be created at '${BACKLOG}'. ` +
          `Re-issue the call with Status='${BACKLOG}' (or omit Status entirely) and ` +
          `run the grooming process before promoting to Ready.`,
      );
      process.exit(2);
    }
  }
}

// notion-update-page: create-only enforcement in v1 — promotion to Ready via
// update_properties is trusted to the operator-correction loop. The matcher is
// still registered in settings.json so update-side strictness can be added
// here later without touching settings.
process.exit(0);
