/**
 * Tests for the task.patchBodySection staged-intent kind: per-(task,section)
 * conflict/dedup scoping (stagedIntents.ts's extractTaskId), human-apply-only
 * classification, and apply-time dispatch through TaskWriteCommands.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return {
    ...actual,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { db } from '../../db/db';
import {
  createStagedIntentsRouter,
  stageIntent,
  composePatchBodySectionPreview,
} from '../stagedIntents';
import { getStagedIntent, transitionStagedIntent } from '../../db/queries';
import { blockToLine } from '../../notion/NotionClient';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('task.patchBodySection — per-(task,section) conflict scoping', () => {
  it('two patches on different sections of the same task both stay active', () => {
    const first = stageIntent(
      'task.patchBodySection',
      {
        taskId: 't-1',
        section: 'Context',
        operation: 'append',
        content: 'more context',
      },
      'proj-1',
    );
    const second = stageIntent(
      'task.patchBodySection',
      {
        taskId: 't-1',
        section: 'Open Questions',
        operation: 'append',
        content: 'a question',
      },
      'proj-1',
    );

    expect(second.id).not.toBe(first.id);
    expect(second.supersedes).toBeFalsy();
    expect(getStagedIntent(first.id)!.state).toBe('staged');
    expect(getStagedIntent(second.id)!.state).toBe('staged');
  });

  it('two differing patches on the same section supersede via the tombstone mechanism', () => {
    const first = stageIntent(
      'task.patchBodySection',
      {
        taskId: 't-1',
        section: 'Context',
        operation: 'append',
        content: 'first draft',
      },
      'proj-1',
    );
    transitionStagedIntent(first.id, 'approved');

    const second = stageIntent(
      'task.patchBodySection',
      {
        taskId: 't-1',
        section: 'Context',
        operation: 'append',
        content: 'revised draft',
      },
      'proj-1',
    );

    expect(second.id).not.toBe(first.id);
    expect(second.supersedes).toBe(first.id);
    expect(second.state).toBe('staged');
    expect(getStagedIntent(first.id)!.state).toBe('superseded');
  });

  it('an identical re-emission on the same section is a no-op that preserves a standing approval', () => {
    const first = stageIntent(
      'task.patchBodySection',
      {
        taskId: 't-1',
        section: 'Context',
        operation: 'append',
        content: 'same content',
      },
      'proj-1',
    );
    transitionStagedIntent(first.id, 'approved');

    const second = stageIntent(
      'task.patchBodySection',
      {
        taskId: 't-1',
        section: 'Context',
        operation: 'append',
        content: 'same content',
      },
      'proj-1',
    );

    expect(second.id).toBe(first.id);
    expect(second.state).toBe('approved');
  });

  it('the same section on a different task is an independent conflict scope', () => {
    const first = stageIntent(
      'task.patchBodySection',
      {
        taskId: 't-1',
        section: 'Context',
        operation: 'remove',
      },
      'proj-1',
    );
    const second = stageIntent(
      'task.patchBodySection',
      {
        taskId: 't-2',
        section: 'Context',
        operation: 'remove',
      },
      'proj-1',
    );

    expect(second.id).not.toBe(first.id);
    expect(second.supersedes).toBeFalsy();
    expect(getStagedIntent(first.id)!.state).toBe('staged');
  });
});

describe('task.patchBodySection — human-apply-only + apply dispatch', () => {
  it('is rejected when applied with a session credential', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      patchBodySection: vi.fn(),
    });

    const staged = stageIntent(
      'task.patchBodySection',
      { taskId: 't-1', section: 'Context', operation: 'remove' },
      'proj-1',
    );

    const app = buildApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${staged.id}/apply`)
      .send({ actorType: 'session' });

    expect(applied.status).toBe(403);
  });

  it('applies through TaskWriteCommands.patchBodySection when applied as human', async () => {
    const patchBodySection = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      patchBodySection,
    });

    const staged = stageIntent(
      'task.patchBodySection',
      {
        taskId: 't-1',
        section: 'Context',
        operation: 'replace',
        find: 'old',
        replaceWith: 'new',
      },
      'proj-1',
    );

    const app = buildApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${staged.id}/apply`)
      .send({});

    expect(applied.status).toBe(200);
    expect(patchBodySection).toHaveBeenCalledWith(
      't-1',
      'Context',
      {
        taskId: 't-1',
        section: 'Context',
        operation: 'replace',
        find: 'old',
        replaceWith: 'new',
      },
      { source: 'human' },
    );
  });
});

describe('task.patchBodySection — staging-time preview matches apply-time rendering', () => {
  it('a multi-line find spanning two bulleted list items that matches the apply-time render also matches the preview', () => {
    // Mirrors NotionClient.fetchTaskPage()'s rendering: each block passed
    // through blockToLine and joined with '\n' — the same rendering
    // patchBodySection's apply path matches `find` against.
    const filesBlocks = [
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ plain_text: 'src/a.ts' }] },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ plain_text: 'src/b.ts' }] },
      },
    ];
    const sectionText = filesBlocks.map(blockToLine).join('\n');
    const storedBody = [
      '## Summary',
      '',
      'Some summary.',
      '',
      '## Files / paths affected',
      '',
      sectionText,
    ].join('\n');

    const find = 'src/a.ts\n- src/b.ts';
    expect(sectionText).toContain(find);

    const preview = composePatchBodySectionPreview(
      storedBody,
      'Files / paths affected',
      { operation: 'replace', find, replaceWith: 'src/a.ts\n- src/c.ts' },
    );

    expect(preview).toContain('src/c.ts');
    expect(preview).not.toContain('src/b.ts');
  });
});
