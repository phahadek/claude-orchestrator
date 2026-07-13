/**
 * Tests for deployService (packages/backend/src/deploy/deployService.ts).
 *
 * AC: reportProjectDeploy records a project's SHA; getProjectDeployedSha
 * reads it back; an unknown/never-reported project reads back null. This is
 * the orchestrator-owned deployed-SHA record — reported in, never read from
 * a deploy-written file.
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { reportProjectDeploy, getProjectDeployedSha } from '../deployService.js';

beforeEach(() => {
  db.prepare('DELETE FROM project_deployed_sha').run();
});

describe('reportProjectDeploy / getProjectDeployedSha', () => {
  it('records a projects deployed sha and reads it back', () => {
    reportProjectDeploy('claude-orchestrator', 'abc123');
    expect(getProjectDeployedSha('claude-orchestrator')).toBe('abc123');
  });

  it('returns null for a project that has never reported in', () => {
    expect(getProjectDeployedSha('never-reported')).toBeNull();
  });

  it('overwrites the prior sha on a subsequent report', () => {
    reportProjectDeploy('claude-orchestrator', 'abc123');
    reportProjectDeploy('claude-orchestrator', 'def456');
    expect(getProjectDeployedSha('claude-orchestrator')).toBe('def456');
  });

  it('tracks each project independently', () => {
    reportProjectDeploy('claude-orchestrator', 'abc123');
    reportProjectDeploy('polimarket-analyser', 'zzz999');
    expect(getProjectDeployedSha('claude-orchestrator')).toBe('abc123');
    expect(getProjectDeployedSha('polimarket-analyser')).toBe('zzz999');
  });
});

describe('deploy is reported in, never read from a deploy-written file', () => {
  it('the deployService source touches no filesystem read of a deploy-written SHA file', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../deployService.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/readFile|DEPLOYED_SHA/i);
  });
});
