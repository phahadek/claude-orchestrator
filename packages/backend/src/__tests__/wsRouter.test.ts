import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const routerSource = fs.readFileSync(
  path.join(__dirname, '..', 'ws', 'router.ts'),
  'utf-8',
);

describe('ws/router.ts — fetch_tasks milestone-based routing', () => {
  it('rejects the legacy { boardId } payload with a clear error', () => {
    expect(routerSource).toMatch(/'boardId' in rawMsg/);
    expect(routerSource).toMatch(/fetch_tasks payload changed/);
  });

  it('resolves the milestone via ProjectService.getMilestone(milestoneId)', () => {
    expect(routerSource).toMatch(
      /ProjectService\.getMilestone\(msg\.milestoneId\)/,
    );
  });

  it('reads the board cache keyed on the milestone UUID (not boardId), never blocking on a live backend round-trip', () => {
    expect(routerSource).toMatch(/getTaskCache\(`board:\$\{milestone\.id\}`\)/);
  });

  it('does not pre-translate milestoneId to source_id (no getMilestoneById call)', () => {
    expect(routerSource).not.toMatch(/getMilestoneById/);
    expect(routerSource).not.toMatch(/resolvedMilestoneId/);
  });
});

describe('ws/router.ts — dispatch empty taskUrl rejection', () => {
  it('rejects tasks with empty taskUrl before calling sessions.start', () => {
    expect(routerSource).toMatch(/!t\.taskUrl/);
    expect(routerSource).toMatch(/dispatch task requires a non-empty taskUrl/);
  });

  it('sends a structured error message for empty taskUrl', () => {
    const emptyTaskUrlBlock = routerSource.slice(
      routerSource.indexOf('!t.taskUrl'),
      routerSource.indexOf('sessions.start'),
    );
    expect(emptyTaskUrlBlock).toMatch(/ws\.send/);
    expect(emptyTaskUrlBlock).toMatch(/type.*error|error.*type/);
  });
});
