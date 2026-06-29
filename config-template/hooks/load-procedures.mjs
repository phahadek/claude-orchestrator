#!/usr/bin/env node
// SessionStart hook — injects config/procedures.md as additionalContext, but
// ONLY for sessions whose cwd is the orchestrator projects root (i.e. the
// human-driven `claude remote-control` server and plain sessions started there).
//
// Why the cwd gate: the durable Remote Control server is the `remote-control`
// SUBCOMMAND, which does NOT accept `--settings`. So this hook can no longer be
// scoped via a dedicated --settings file; it must live in ~/.claude/settings.json
// (always loaded). To avoid leaking procedures.md into orchestrator-launched
// (automated) sessions — which run with cwd = <repo>/.claude/worktrees/<id>,
// descendants of the projects root — we self-gate: emit only when cwd EXACTLY
// equals the projects root. Worktree sessions, and plain sessions elsewhere,
// get nothing.
//
// Path-portable: resolves procedures.md AND the projects root relative to this
// script. The config tree lives INSIDE the projects root on every host (dev:
// ~/IdeaProjects/config, prod: /srv/orchestrator/projects/config), so the projects
// root is always config's parent — no host-specific override needed.
// ORCHESTRATOR_PROJECTS_ROOT remains an optional escape hatch for the unusual case
// of config deployed outside the projects root.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Normalize for comparison: absolute, no trailing slash; case-insensitive +
// forward-slashed on Windows.
function norm(p) {
  const r = resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.replace(/\\/g, '/').toLowerCase() : r;
}

function main() {
  // Session cwd comes from the authoritative SessionStart hook input on stdin.
  // We do NOT fall back to process.cwd(): the hook may run with cwd = the
  // projects root regardless of the session, so a fallback would inject into
  // EVERY session (the exact leak we're preventing). If cwd can't be read,
  // fail closed — inject nothing.
  let cwd;
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim()) cwd = JSON.parse(raw).cwd;
  } catch {
    /* no/invalid stdin */
  }
  if (!cwd) return; // fail closed

  // Projects root: env override (prod) > parent of the config tree (dev default).
  const configDir = fileURLToPath(new URL('..', import.meta.url)); // hooks/.. = config
  const projectsRoot = process.env.ORCHESTRATOR_PROJECTS_ROOT
    ? resolve(process.env.ORCHESTRATOR_PROJECTS_ROOT)
    : resolve(configDir, '..'); // config/.. = projects root (config lives inside it)

  // Gate: only inject at the projects root. Anywhere else (worktrees, repos,
  // unrelated dirs) → silent no-op, so automated sessions never inherit it.
  if (norm(cwd) !== norm(projectsRoot)) return;

  const proceduresPath = fileURLToPath(
    new URL('../procedures.md', import.meta.url),
  );
  if (!existsSync(proceduresPath)) return; // nothing to point at → fail closed

  // Keep additionalContext SMALL: the harness truncates a large SessionStart
  // injection to a short preview. So emit a compact pointer that DIRECTS the
  // session to Read procedures.md in full, rather than inlining the whole
  // rulebook (which would arrive truncated and unreliable).
  const p = proceduresPath.replace(/\\/g, '/');
  const msg = [
    'You are in an Orchestrator Remote Control session (cwd = the projects root).',
    '',
    'FIRST, before any other work, Read this file IN FULL — it is the universal',
    'procedure + workflow rulebook and the per-project index:',
    `  ${p}`,
    '',
    'Then, to work a specific project, Read config/projects/<dir>/context.md as the',
    'rulebook directs. Do not skip the rulebook.',
  ].join('\n');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: msg,
      },
    }),
  );
}

try {
  main();
} catch (err) {
  // Fail open: never block session start on a hook error. Surface to stderr only.
  process.stderr.write(`[load-procedures] could not load procedures.md: ${err.message}\n`);
}
