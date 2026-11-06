import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  isWorktreeCwd,
  buildHookOutput,
} from '../inject-code-session-rules.mjs';

const REAL_RULES_PATH = fileURLToPath(
  new URL('../../code-session-rules.md', import.meta.url),
);
const MISSING_RULES_PATH = fileURLToPath(
  new URL('../../does-not-exist.md', import.meta.url),
);

describe('inject-code-session-rules.mjs', () => {
  it('fires for a standard worktree session cwd', () => {
    const cwd =
      '/srv/orchestrator/projects/some-repo/.claude/worktrees/11111111-1111-1111-1111-111111111111';
    assert.equal(isWorktreeCwd(cwd), true);
    const output = buildHookOutput(cwd, REAL_RULES_PATH);
    assert.ok(output);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /code-session-rules\.md/,
    );
  });

  it('fires for an ops session cwd (identical worktree shape)', () => {
    const cwd =
      '/srv/orchestrator/projects/some-repo/.claude/worktrees/22222222-2222-2222-2222-222222222222';
    assert.equal(isWorktreeCwd(cwd), true);
    assert.ok(buildHookOutput(cwd, REAL_RULES_PATH));
  });

  it('fires for a repo-target docs session cwd (identical worktree shape)', () => {
    const cwd =
      '/srv/orchestrator/projects/some-repo/.claude/worktrees/33333333-3333-3333-3333-333333333333';
    assert.equal(isWorktreeCwd(cwd), true);
    assert.ok(buildHookOutput(cwd, REAL_RULES_PATH));
  });

  it('does not fire at the projects root', () => {
    const cwd = '/srv/orchestrator/projects';
    assert.equal(isWorktreeCwd(cwd), false);
    assert.equal(buildHookOutput(cwd, REAL_RULES_PATH), undefined);
  });

  it('does not fire for a review/depth_review session (project root, no worktree)', () => {
    const cwd = '/srv/orchestrator/projects/some-repo';
    assert.equal(isWorktreeCwd(cwd), false);
    assert.equal(buildHookOutput(cwd, REAL_RULES_PATH), undefined);
  });

  it('is inert (no-op) when code-session-rules.md is absent, rather than throwing', () => {
    const cwd =
      '/srv/orchestrator/projects/some-repo/.claude/worktrees/44444444-4444-4444-4444-444444444444';
    assert.doesNotThrow(() => buildHookOutput(cwd, MISSING_RULES_PATH));
    assert.equal(buildHookOutput(cwd, MISSING_RULES_PATH), undefined);
  });
});
