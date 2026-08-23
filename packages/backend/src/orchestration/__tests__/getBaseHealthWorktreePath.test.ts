/**
 * Tests for getBaseHealthWorktreePath's namespacing relative to
 * ScheduledAuditSweep's own worktree checkout. Pure/synchronous — kept out
 * of baseHealthCheck.test.ts so it never shares a vitest worker with that
 * file's real-sqlite/real-timer checkBaseBranchHealth tests.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { getBaseHealthWorktreePath } from '../baseHealthCheck';
import { getAuditWorktreePath } from '../ScheduledAuditSweep';
import type { ProjectConfig } from '../../config';

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Project One',
    projectDir: '/tmp/fake-project-dir',
    contextUrl: 'https://example.com',
    boardId: 'board-1',
    taskSource: 'notion',
    gitMode: 'github',
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: false,
    dataResidencyConfirmed: true,
    baseBranch: 'dev',
    nonMilestoneSourceConfig: { notionDatabaseId: 'db-nonmilestone' },
    ...overrides,
  } as ProjectConfig;
}

describe('getBaseHealthWorktreePath', () => {
  it("is namespaced outside ScheduledAuditSweep's own worktree and outside a bare worktreesDir/<sessionId> path", () => {
    const project = makeProject();
    const healthPath = getBaseHealthWorktreePath(project);
    const auditPath = getAuditWorktreePath(project);

    expect(healthPath).not.toBe(auditPath);

    const worktreesDir = path.join(project.projectDir, '.claude', 'worktrees');
    // Mirrors ScheduledAuditSweep's own namespacing: nested at least one
    // segment deeper than `worktreesDir/<name>` so WorktreeReconciler's
    // exact `worktreesDir/<sessionId>` match can never hit it.
    const relative = path.relative(worktreesDir, healthPath);
    expect(relative.split(path.sep).length).toBeGreaterThan(1);
    expect(healthPath.startsWith(path.join(worktreesDir, 'base-health'))).toBe(
      true,
    );
  });
});
