#!/usr/bin/env node
// SessionStart hook — injects config/code-session-rules.md as additionalContext,
// but ONLY for automated, worktree-based code sessions (standard, ops, and
// repo-target docs sessions all share the identical
// `<projectDir>/.claude/worktrees/<uuid>` cwd shape — see usesWorktree() in
// packages/backend/src/session/sessionPredicates.ts).
//
// This is the mirror image of load-procedures.mjs: that hook fires ONLY at
// the projects root (the human-driven Remote Control session) and self-
// excludes worktree sessions. This hook fires ONLY under a worktree path and
// self-excludes the projects root. Neither ever fires for review/depth_review
// sessions, which run without a worktree, at the project root.
//
// There is no session-type signal available in the cwd, env, or filesystem
// to distinguish 'standard' from 'ops'/docs worktree sessions, so this hook
// intentionally does not try — it fires for ALL worktree sessions alike.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Matches a `.claude/worktrees/<id>` path segment anywhere in cwd, on either
// path-separator style (Windows sessions may report backslashes).
const WORKTREE_SEGMENT = /(?:^|[\\/])\.claude[\\/]worktrees[\\/][^\\/]+/;

/** Session cwd is somewhere under a `.claude/worktrees/<id>` directory. */
export function isWorktreeCwd(cwd) {
  return typeof cwd === 'string' && WORKTREE_SEGMENT.test(cwd);
}

/**
 * Read the SessionStart hook's stdin payload and extract `cwd`.
 * Returns undefined if stdin is empty/invalid — callers should fail closed.
 */
export function readCwdFromStdin(fd = 0) {
  try {
    const raw = readFileSync(fd, 'utf8');
    if (raw.trim()) return JSON.parse(raw).cwd;
  } catch {
    /* no/invalid stdin */
  }
  return undefined;
}

const rulesPath = fileURLToPath(
  new URL('../code-session-rules.md', import.meta.url),
);

/**
 * Build the hook's stdout payload for a given cwd, or undefined if the hook
 * should no-op (not a worktree cwd, or code-session-rules.md is missing).
 */
export function buildHookOutput(cwd, resolvedRulesPath = rulesPath) {
  if (!isWorktreeCwd(cwd)) return undefined;
  if (!existsSync(resolvedRulesPath)) return undefined; // fail closed

  const p = resolvedRulesPath.replace(/\\/g, '/');
  const msg = [
    'You are in an orchestrator-dispatched code session (cwd = a worktree).',
    '',
    'FIRST, before any other work, Read this file IN FULL — it is the universal',
    'code-session rulebook that applies regardless of project:',
    `  ${p}`,
  ].join('\n');
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: msg,
    },
  };
}

function main() {
  const cwd = readCwdFromStdin();
  if (!cwd) return; // fail closed
  const output = buildHookOutput(cwd);
  if (!output) return;
  process.stdout.write(JSON.stringify(output));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    // Fail open: never block session start on a hook error.
    process.stderr.write(
      `[inject-code-session-rules] could not load code-session-rules.md: ${err.message}\n`,
    );
  }
}
