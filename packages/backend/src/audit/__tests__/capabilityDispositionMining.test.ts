/**
 * Tests for the auto-deny half of capability-disposition-trail mining
 * (packages/backend/src/audit/capabilityDispositionMining.ts).
 *
 * AC: a key qualifies only at 5+ operator_denied/declined dispositions
 * spanning 2+ distinct task_ids with zero approvals ever recorded; a key
 * already matched by GRANT_DENYLIST_PATTERNS or already disqualified is
 * excluded; resolving the Investigation's disqualification lifts or hardens
 * it, and a lift only excludes denials predating the lift from re-counting.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { recordEvent } from '../AuditLog.js';
import {
  findQualifyingDenialPatterns,
  recordDisqualification,
  resolveCapabilityDisqualification,
} from '../capabilityDispositionMining.js';
import { getCapabilityDisqualification } from '../../db/queries.js';

const PROJECT = 'test-project';
const CAPABILITY = 'Bash(sqlite3:*)';

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM capability_disqualification').run();
});

function denial(capability: string, taskId: string | null, project = PROJECT) {
  recordEvent({
    event_type: 'capability_request_disposition',
    actor_type: 'human',
    actor_id: null,
    project_id: project,
    task_id: taskId,
    payload: {
      capability,
      disposition: 'operator_denied',
      provenance: 'operator',
    },
  });
}

function approval(
  capability: string,
  taskId: string | null,
  project = PROJECT,
) {
  recordEvent({
    event_type: 'capability_request_disposition',
    actor_type: 'human',
    actor_id: null,
    project_id: project,
    task_id: taskId,
    payload: {
      capability,
      disposition: 'operator_approved',
      provenance: 'operator',
    },
  });
}

describe('findQualifyingDenialPatterns', () => {
  it('qualifies a key with 5+ denials spanning 2+ tasks and no approvals', () => {
    denial(CAPABILITY, 'task-1');
    denial(CAPABILITY, 'task-1');
    denial(CAPABILITY, 'task-1');
    denial(CAPABILITY, 'task-2');
    denial(CAPABILITY, 'task-2');

    const patterns = findQualifyingDenialPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({
      projectId: PROJECT,
      capability: CAPABILITY,
      denialCount: 5,
    });
    expect(patterns[0].taskIds.sort()).toEqual(['task-1', 'task-2']);
  });

  it('excludes a key with fewer than 5 denials', () => {
    denial(CAPABILITY, 'task-1');
    denial(CAPABILITY, 'task-2');
    expect(findQualifyingDenialPatterns()).toHaveLength(0);
  });

  it('excludes a key whose 5+ denials all come from a single task', () => {
    for (let i = 0; i < 6; i++) denial(CAPABILITY, 'task-1');
    expect(findQualifyingDenialPatterns()).toHaveLength(0);
  });

  it('excludes a key with any operator_approved disposition ever recorded', () => {
    for (let i = 0; i < 5; i++) denial(CAPABILITY, `task-${i % 2}`);
    approval(CAPABILITY, 'task-9');
    expect(findQualifyingDenialPatterns()).toHaveLength(0);
  });

  it('excludes a key already matched by GRANT_DENYLIST_PATTERNS', () => {
    for (let i = 0; i < 5; i++) denial('Write', `task-${i % 2}`);
    expect(findQualifyingDenialPatterns()).toHaveLength(0);
  });

  it('excludes a key with an open disqualification', () => {
    for (let i = 0; i < 5; i++) denial(CAPABILITY, `task-${i % 2}`);
    recordDisqualification(
      {
        projectId: PROJECT,
        capability: CAPABILITY,
        denialCount: 5,
        taskIds: ['task-0', 'task-1'],
      },
      'investigation-1',
      new Date(0).toISOString(),
    );
    expect(findQualifyingDenialPatterns()).toHaveLength(0);
  });

  it('excludes a hardened key permanently', () => {
    for (let i = 0; i < 5; i++) denial(CAPABILITY, `task-${i % 2}`);
    recordDisqualification(
      {
        projectId: PROJECT,
        capability: CAPABILITY,
        denialCount: 5,
        taskIds: ['task-0', 'task-1'],
      },
      'investigation-1',
      new Date(0).toISOString(),
    );
    resolveCapabilityDisqualification(
      'investigation-1',
      { capabilityDisqualificationVerdict: 'hardened' },
      new Date(1000).toISOString(),
    );
    expect(getCapabilityDisqualification(PROJECT, CAPABILITY)?.state).toBe(
      'hardened',
    );
    expect(findQualifyingDenialPatterns()).toHaveLength(0);
  });

  it('after a lift, only re-counts denials recorded after the lift', async () => {
    for (let i = 0; i < 5; i++) denial(CAPABILITY, `task-${i % 2}`);
    recordDisqualification(
      {
        projectId: PROJECT,
        capability: CAPABILITY,
        denialCount: 5,
        taskIds: ['task-0', 'task-1'],
      },
      'investigation-1',
      new Date(0).toISOString(),
    );

    // Give the pre-lift denials a moment to age behind the lift timestamp —
    // recordEvent stamps each row with the real clock, so the lift point
    // must be real "now", not a synthetic early timestamp.
    await new Promise((r) => setTimeout(r, 5));
    resolveCapabilityDisqualification(
      'investigation-1',
      { capabilityDisqualificationVerdict: 'lifted' },
      new Date().toISOString(),
    );
    expect(getCapabilityDisqualification(PROJECT, CAPABILITY)?.state).toBe(
      'lifted',
    );
    await new Promise((r) => setTimeout(r, 5));

    // Only 2 post-lift denials so far — not enough to re-qualify, even
    // though the pre-lift 5 are still sitting in audit_log.
    denial(CAPABILITY, 'task-2');
    denial(CAPABILITY, 'task-3');
    expect(findQualifyingDenialPatterns()).toHaveLength(0);

    // Once enough post-lift denials accumulate, it re-qualifies — counting
    // only the post-lift evidence.
    denial(CAPABILITY, 'task-2');
    denial(CAPABILITY, 'task-3');
    denial(CAPABILITY, 'task-2');
    const patterns = findQualifyingDenialPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].denialCount).toBe(5);
    expect(patterns[0].taskIds.sort()).toEqual(['task-2', 'task-3']);
  });
});

describe('resolveCapabilityDisqualification', () => {
  it('is a no-op for a task not tied to any disqualification', () => {
    expect(() =>
      resolveCapabilityDisqualification(
        'unrelated-task',
        { capabilityDisqualificationVerdict: 'lifted' },
        new Date().toISOString(),
      ),
    ).not.toThrow();
  });

  it('defaults to hardened when the resolution carries no explicit verdict', () => {
    recordDisqualification(
      {
        projectId: PROJECT,
        capability: CAPABILITY,
        denialCount: 5,
        taskIds: ['task-0', 'task-1'],
      },
      'investigation-1',
      new Date(0).toISOString(),
    );
    resolveCapabilityDisqualification(
      'investigation-1',
      { note: 'looked into it' },
      new Date(1000).toISOString(),
    );
    expect(getCapabilityDisqualification(PROJECT, CAPABILITY)?.state).toBe(
      'hardened',
    );
  });
});
