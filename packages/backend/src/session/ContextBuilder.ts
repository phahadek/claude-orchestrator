import fs from 'fs';
import path from 'path';
import { buildOrchestratorClaudeMd } from './orchestrator-claudemd';

export interface BuildSessionContextParams {
  taskName: string;
  taskUrl: string;
  projectContextUrl: string;
  targetBranch: string;
  projectDir: string;
  worktreePath: string;
  prGate?: { typeCheck: string; build: string };
  bashRules?: string[];
  taskBackend?: 'notion' | 'local';
  /** Pre-fetched task spec markdown. Passed through to orchestrator CLAUDE.md. */
  taskContent?: string;
  /** Git mode: 'local-only' omits PR instructions; 'github' (default) keeps full PR flow. */
  gitMode?: 'github' | 'local-only';
}

/**
 * Strip stale orchestrator rules from a project CLAUDE.md.
 *
 * If a previous session escaped its worktree and wrote the orchestrator header
 * to the project's CLAUDE.md, subsequent sessions would see double orchestrator
 * rules — one from the injected content and one embedded in "Project Instructions".
 * This function detects and removes the stale orchestrator block so only the
 * project's own instructions remain.
 *
 * Exported for testing.
 */
export function stripOrchestratorHeader(md: string): string {
  if (!md.startsWith('# Orchestrator Rules')) return md;

  // The orchestrator block ends at "# Project Instructions" — the separator
  // added by buildSessionContext when the orchestrator was originally injected.
  const marker = '# Project Instructions';
  const idx = md.indexOf(marker);
  if (idx === -1) {
    // No "# Project Instructions" found — the entire file is orchestrator content.
    // Return empty so the session only sees its own injected orchestrator rules.
    return '';
  }

  // Skip the "# Project Instructions" heading and any blank lines after it.
  let rest = md.slice(idx + marker.length);
  rest = rest.replace(/^\n+/, '');
  return rest;
}

/**
 * Build the merged session context string — orchestrator rules + project CLAUDE.md.
 *
 * This is the content that used to be written to the worktree's CLAUDE.md for CLI mode.
 * For API mode the same content is injected as the system prompt instead.
 *
 * Both runners consume this function so the content is always identical regardless of
 * the delivery method.
 */
export function buildSessionContext(params: BuildSessionContextParams): string {
  const {
    taskName,
    taskUrl,
    projectContextUrl,
    targetBranch,
    projectDir,
    worktreePath,
    prGate,
    bashRules,
    taskBackend,
    taskContent,
    gitMode,
  } = params;

  // Read project-level local context (Notion URLs, board IDs, etc.) if present.
  // Gitignored, populated per-host by the developer. Falls through silently
  // when the file is absent — e.g. on a fresh clone before setup.
  let localContext: string | undefined;
  try {
    const localContextPath = path.join(
      projectDir,
      '.claude',
      'local-context.md',
    );
    if (fs.existsSync(localContextPath)) {
      localContext = fs.readFileSync(localContextPath, 'utf-8');
    }
  } catch {
    // Ignore — fall through without local context.
  }

  // Return only orchestrator content. Since we now write to .claude/CLAUDE.md
  // (gitignored), the project's own root CLAUDE.md is read independently by
  // Claude Code — no merging needed.
  return buildOrchestratorClaudeMd({
    taskName,
    taskUrl,
    projectContextUrl,
    targetBranch,
    worktreePath,
    prGate,
    bashRules,
    taskBackend,
    taskContent,
    localContext,
    gitMode,
  });
}
