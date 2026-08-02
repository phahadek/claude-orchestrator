import { describe, it, expect } from 'vitest';
import {
  WORKFLOW_SCOPE_DENYLIST,
  matchesWorkflowScopeDenylist,
} from '../workflowScopeDenylist';

describe('WORKFLOW_SCOPE_DENYLIST', () => {
  it('seeds .github/workflows/** as a denied region', () => {
    expect(WORKFLOW_SCOPE_DENYLIST).toContain('.github/workflows/**');
  });
});

describe('matchesWorkflowScopeDenylist', () => {
  it('matches a workflow file under .github/workflows/', () => {
    expect(
      matchesWorkflowScopeDenylist(['.github/workflows/build.yml']),
    ).toBe(true);
  });

  it('does not match an unrelated path', () => {
    expect(
      matchesWorkflowScopeDenylist(['packages/backend/src/index.ts']),
    ).toBe(false);
  });

  it('matches when any of several paths falls under the denylist', () => {
    expect(
      matchesWorkflowScopeDenylist([
        'packages/backend/src/index.ts',
        '.github/workflows/deploy.yml',
      ]),
    ).toBe(true);
  });

  it('routes an ops-session discovered fix to the PR-creation intent instead of task.create when its target path matches the denylist', () => {
    // The ops session has no worktree/git-diff — it checks the fix's
    // self-reported target path(s) directly (see procedureAssembler.ts's
    // renderOpsCapabilities denylist branch).
    const discoveredFixTargetPaths = ['.github/workflows/ci.yml'];
    const shouldRouteToPrIntent = matchesWorkflowScopeDenylist(
      discoveredFixTargetPaths,
    );
    expect(shouldRouteToPrIntent).toBe(true);
  });
});
