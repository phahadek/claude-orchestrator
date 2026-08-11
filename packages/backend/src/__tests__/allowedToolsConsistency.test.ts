import { describe, it, expect } from 'vitest';
import { buildOrchestratorClaudeMd } from '../session/orchestrator-claudemd';
import {
  ALLOWED_TOOLS,
  GROOM_ALLOWED_TOOLS,
  DESIGN_ALLOWED_TOOLS,
  OPS_ALLOWED_TOOLS,
  DOCS_ALLOWED_TOOLS,
} from '../config';

/**
 * Guard against the class of bug this file was added for: the injected
 * Pre-PR Gate / Flaky-CI procedure text (session/orchestrator-claudemd.ts)
 * mandates calling specific mcp__orchestrator__* tools by name, but that
 * text is assembled independently of the --allowed-tools list actually
 * handed to the CLI (config.ts). A tool can be added to the prose without
 * ever being allow-listed — the CLI then silently denies every call, and a
 * standard/code session opens its PR having never run the mandated tool
 * (observed live: session aeeba0b5, PR phahadek/polimarket-analyser#903).
 *
 * Only the standard/code session template (buildOrchestratorClaudeMd) names
 * mcp__orchestrator__* tools in its rendered text — buildReviewClaudeMd and
 * buildDepthReviewClaudeMd (the review/depth_review templates) do not — so
 * ALLOWED_TOOLS (the code-session set) is the only allow-list checked here.
 */
const CODE_SESSION_INJECTED_TEXT = buildOrchestratorClaudeMd({
  taskName: 'Example task',
  taskUrl: 'https://example.com/task',
  projectContextUrl: 'https://example.com/context',
  targetBranch: 'dev',
  worktreePath: '/tmp/worktree',
  gitMode: 'github',
});

function mentionedOrchestratorTools(text: string): string[] {
  return [...new Set(text.match(/mcp__orchestrator__[A-Za-z_]+/g) ?? [])];
}

describe('injected Pre-PR Gate text vs code-session allowed-tools consistency guard', () => {
  it('the rendered code-session text actually mentions mcp__orchestrator__* tools (sanity check the regex has something to find)', () => {
    expect(mentionedOrchestratorTools(CODE_SESSION_INJECTED_TEXT).length).toBeGreaterThan(0);
  });

  it('every mcp__orchestrator__* tool named in the injected code-session text is present in ALLOWED_TOOLS', () => {
    const mentioned = mentionedOrchestratorTools(CODE_SESSION_INJECTED_TEXT);
    const missing = mentioned.filter((tool) => !ALLOWED_TOOLS.includes(tool));
    expect(missing).toEqual([]);
  });

  it('specifically mandates and allow-lists test_request, flaky_confirm, and review_disposition', () => {
    for (const tool of [
      'mcp__orchestrator__test_request',
      'mcp__orchestrator__flaky_confirm',
      'mcp__orchestrator__review_disposition',
    ]) {
      expect(CODE_SESSION_INJECTED_TEXT).toContain(tool);
      expect(ALLOWED_TOOLS).toContain(tool);
    }
  });

  it('allow-list entries use the CLI-exposed underscore form, never the dotted registration name', () => {
    for (const tool of mentionedOrchestratorTools(CODE_SESSION_INJECTED_TEXT)) {
      expect(tool).not.toMatch(/\./);
    }
  });

  it('no other session type gains test_request implicitly as a side effect of this fix', () => {
    for (const list of [
      GROOM_ALLOWED_TOOLS,
      DESIGN_ALLOWED_TOOLS,
      OPS_ALLOWED_TOOLS,
      DOCS_ALLOWED_TOOLS,
    ]) {
      expect(list).not.toContain('mcp__orchestrator__test_request');
    }
  });
});
