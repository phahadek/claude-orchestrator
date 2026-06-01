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

  it('resolves the per-project task backend via getTaskBackend(projectId)', () => {
    expect(routerSource).toMatch(/getTaskBackend\(msg\.projectId\)/);
  });

  it('forwards milestoneId (not boardId) to backend.fetchReadyTasks()', () => {
    expect(routerSource).toMatch(/\.fetchReadyTasks\(msg\.milestoneId/);
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
