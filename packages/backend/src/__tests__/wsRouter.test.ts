import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const routerSource = fs.readFileSync(
  path.join(__dirname, '..', 'ws', 'router.ts'),
  'utf-8',
);

describe('ws/router.ts — fetch_tasks boardId handling', () => {
  it('uses msg.boardId when provided, falls back to project.boardId when absent', () => {
    // Must use nullish coalescing: msg.boardId ?? project.boardId
    expect(routerSource).toMatch(/msg\.boardId\s*\?\?\s*project\.boardId/);
  });

  it('passes the resolved boardId to notion.fetchReadyTasks()', () => {
    // Must call fetchReadyTasks with the local boardId variable
    expect(routerSource).toMatch(/notion\.fetchReadyTasks\(boardId\)/);
  });
});
