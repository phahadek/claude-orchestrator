/**
 * Regression coverage for the milestone key-space normalization on gate/seed
 * accretion: every dispatched planning session passes the milestone as its
 * DB UUID, but gate_item.milestone / seed_item.milestone must hold the
 * canonical display name — otherwise an accretion that carries items writes
 * into a shadow key-space that getGateReadiness/getSeedReadiness never read
 * (they match the milestone key verbatim, by design).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const M12_UUID = '8c381caa-31a8-41df-add7-2578a14f47d8';

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getById: (id: string) => {
      if (id !== 'polimarket-analyser') return undefined;
      return {
        id,
        milestones: [{ id: M12_UUID, name: 'M12', canonicalShortId: 'M12' }],
      };
    },
  },
}));

import { BackendTaskWriteCommands } from '../TaskWriteCommands';
import type { TaskBackend } from '../TaskBackend';
import { getGateReadiness } from '../../gate/gateService';
import { getSeedReadiness } from '../../seed/seedService';
import { db } from '../../db/db.js';

function makeBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(),
    attachPR: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nfine'),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn(),
    createTask: vi.fn().mockResolvedValue('notion:new-id'),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
    setType: vi.fn().mockResolvedValue(undefined),
    setProperties: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    updateBody: vi.fn().mockResolvedValue(undefined),
    updateBodyRaw: vi.fn().mockResolvedValue(undefined),
  };
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM seed_item_source').run();
  db.prepare('DELETE FROM seed_item').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('accreteGateContribution — milestone key-space normalization', () => {
  it('persists a gate_item keyed by the canonical display name when the source task carries the milestone UUID', async () => {
    const commands = new BackendTaskWriteCommands(makeBackend());

    await commands.accreteGateContribution(
      {
        id: 'notion:src-1',
        title: 'Add the webhook',
        project: 'polimarket-analyser',
        milestone: M12_UUID,
      },
      [{ text: 'Verify the webhook fires' }],
      'Read-Only',
    );

    const row = db.prepare('SELECT milestone FROM gate_item').get() as
      | { milestone: string }
      | undefined;
    expect(row?.milestone).toBe('M12');
    expect(row?.milestone).not.toMatch(UUID_SHAPE);

    const readiness = getGateReadiness('polimarket-analyser', 'M12');
    expect(readiness.blocking).toHaveLength(1);
    expect(readiness.blocking[0].text).toBe('Verify the webhook fires');
  });

  it('persists a gate_item unchanged when the source task already carries the display name', async () => {
    const commands = new BackendTaskWriteCommands(makeBackend());

    await commands.accreteGateContribution(
      {
        id: 'notion:src-1',
        title: 'Add the webhook',
        project: 'polimarket-analyser',
        milestone: 'M12',
      },
      [{ text: 'Verify the webhook fires' }],
      'Read-Only',
    );

    const row = db.prepare('SELECT milestone FROM gate_item').get() as
      | { milestone: string }
      | undefined;
    expect(row?.milestone).toBe('M12');
  });

  it('never persists a UUID-shaped gate_item.milestone', async () => {
    const commands = new BackendTaskWriteCommands(makeBackend());

    await commands.accreteGateContribution(
      {
        id: 'notion:src-1',
        title: 'Add the webhook',
        project: 'polimarket-analyser',
        milestone: M12_UUID,
      },
      [{ text: 'Verify the webhook fires' }, { text: 'Check the retry path' }],
      'Read-Only',
    );

    const rows = db.prepare('SELECT milestone FROM gate_item').all() as {
      milestone: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.milestone).not.toMatch(UUID_SHAPE);
    }
  });
});

describe('stageSeedContribution — milestone key-space normalization', () => {
  it('persists a seed_item keyed by the canonical display name when the source task carries the milestone UUID', async () => {
    const commands = new BackendTaskWriteCommands(makeBackend());

    await commands.stageSeedContribution(
      {
        id: 'notion:src-1',
        title: 'Add the webhook',
        project: 'polimarket-analyser',
        milestone: M12_UUID,
      },
      [{ spec: 'Add webhook_url to config' }],
      'seeds',
    );

    const row = db.prepare('SELECT milestone FROM seed_item').get() as
      | { milestone: string }
      | undefined;
    expect(row?.milestone).toBe('M12');
    expect(row?.milestone).not.toMatch(UUID_SHAPE);

    const readiness = getSeedReadiness('polimarket-analyser', 'M12');
    expect(readiness.blocking).toHaveLength(1);
    expect(readiness.blocking[0].spec).toBe('Add webhook_url to config');
  });

  it('persists a seed_item unchanged when the source task already carries the display name', async () => {
    const commands = new BackendTaskWriteCommands(makeBackend());

    await commands.stageSeedContribution(
      {
        id: 'notion:src-1',
        title: 'Add the webhook',
        project: 'polimarket-analyser',
        milestone: 'M12',
      },
      [{ spec: 'Add webhook_url to config' }],
      'seeds',
    );

    const row = db.prepare('SELECT milestone FROM seed_item').get() as
      | { milestone: string }
      | undefined;
    expect(row?.milestone).toBe('M12');
  });
});
