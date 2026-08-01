/**
 * Tests for countLivePlanningSessions (packages/backend/src/db/queries.ts).
 *
 * AC: archived sessions never count as live capacity, even when their
 * status is non-terminal (e.g. idle); an unarchived idle planning session
 * still counts, since idle is deliberately non-terminal and routinely
 * resumed — archived is the discriminator, not status.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import { insertSession, archiveSession, countLivePlanningSessions } from '../queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
});

function seedSession(opts: {
  sessionId: string;
  sessionType: string;
  status: string;
  archived?: boolean;
}): void {
  insertSession({
    session_id: opts.sessionId,
    task_id: `task-${opts.sessionId}`,
    task_url: null,
    project_context_url: null,
    status: opts.status,
    started_at: 0,
    session_type: opts.sessionType,
    task_name: null,
  } as never);
  if (opts.archived) archiveSession(opts.sessionId);
}

describe('countLivePlanningSessions', () => {
  it('does not count archived sessions even when their status is non-terminal (idle)', () => {
    seedSession({
      sessionId: 'archived-idle',
      sessionType: 'groom',
      status: 'idle',
      archived: true,
    });

    expect(countLivePlanningSessions()).toBe(0);
  });

  it('still counts a live, unarchived idle planning session', () => {
    seedSession({
      sessionId: 'unarchived-idle',
      sessionType: 'groom',
      status: 'idle',
    });

    expect(countLivePlanningSessions()).toBe(1);
  });

  it('still counts a live, unarchived running planning session', () => {
    seedSession({
      sessionId: 'unarchived-running',
      sessionType: 'design',
      status: 'running',
    });

    expect(countLivePlanningSessions()).toBe(1);
  });

  it('mirrors the reported incident shape: many archived idle rows do not swamp a few live ones', () => {
    for (let i = 0; i < 104; i++) {
      seedSession({
        sessionId: `archived-idle-${i}`,
        sessionType: 'ops',
        status: 'idle',
        archived: true,
      });
    }
    seedSession({
      sessionId: 'live-running',
      sessionType: 'ops',
      status: 'running',
    });
    for (let i = 0; i < 3; i++) {
      seedSession({
        sessionId: `live-idle-${i}`,
        sessionType: 'ops',
        status: 'idle',
      });
    }

    expect(countLivePlanningSessions()).toBe(4);
  });

  it('does not count a standard (code) session even if unarchived and running', () => {
    seedSession({
      sessionId: 'standard-running',
      sessionType: 'standard',
      status: 'running',
    });

    expect(countLivePlanningSessions()).toBe(0);
  });

  it('does not count a terminal, unarchived planning session', () => {
    seedSession({
      sessionId: 'done-groom',
      sessionType: 'groom',
      status: 'done',
    });

    expect(countLivePlanningSessions()).toBe(0);
  });
});
