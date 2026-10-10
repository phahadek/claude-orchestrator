import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../db/queries', () => ({
  insertBuildingDependencyCacheEntry: vi.fn(),
  markDependencyCacheEntryStatus: vi.fn(),
  getReadyDependencyCacheEntry: vi.fn(),
  touchDependencyCacheEntryLastUsed: vi.fn(),
  listBuildingDependencyCacheEntries: vi.fn(() => []),
}));
vi.mock('../../session/analyzeGating', () => ({
  computeTriggerContentHash: vi.fn(async () => 'hash-abc'),
}));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  tryDependencyCachePool,
  recoverInterruptedDependencyCacheBuilds,
  type DependencyCacheStore,
} from '../dependencyCachePool';
import type { DependencyCacheEntryRow } from '../../db/types';

function makeMemoryStore(): DependencyCacheStore & {
  rows: Map<string, DependencyCacheEntryRow>;
  inserts: number;
} {
  const rows = new Map<string, DependencyCacheEntryRow>();
  const k = (p: string, h: string) => `${p}:${h}`;
  const store = {
    rows,
    inserts: 0,
    insertBuilding(projectId: string, lockHash: string) {
      store.inserts++;
      rows.set(k(projectId, lockHash), {
        project_id: projectId,
        lock_hash: lockHash,
        status: 'building',
        created_at: Date.now(),
        last_used_at: Date.now(),
      } as DependencyCacheEntryRow);
    },
    markStatus(projectId: string, lockHash: string, status: never) {
      const r = rows.get(k(projectId, lockHash));
      if (r) r.status = status;
    },
    getReady(projectId: string, lockHash: string) {
      const r = rows.get(k(projectId, lockHash));
      return r?.status === 'ready' ? r : undefined;
    },
    touchLastUsed() {},
    listBuilding() {
      return [...rows.values()].filter((r) => r.status === 'building');
    },
  };
  return store;
}

describe('dependencyCachePool with injected store', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depcache-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('coalesces two concurrent misses for the same (projectId, lockHash) into one build', async () => {
    const store = makeMemoryStore();
    const counter = path.join(tmp, 'count');
    const script = path.join(tmp, 'bootstrap.sh');
    fs.writeFileSync(
      script,
      `#!/bin/bash\necho x >> "${counter}"\nsleep 0.3\nmkdir -p "$1/node_modules"\necho dep > "$1/node_modules/a"\n`,
    );
    const mk = (n: string) => {
      const wt = path.join(tmp, n);
      fs.mkdirSync(wt);
      return {
        projectId: 'p1',
        projectDir: tmp,
        worktreePath: wt,
        bootstrapScript: script,
        lockPaths: ['lock'],
        cacheDirs: ['node_modules'],
        verifyCommand: 'true',
        sessionId: `session-${n}`,
        store,
        dataDir: path.join(tmp, 'data'),
      };
    };
    const [a, b] = await Promise.all([
      tryDependencyCachePool(mk('w1')),
      tryDependencyCachePool(mk('w2')),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(store.inserts).toBe(1);
    expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(path.join(tmp, 'w2', 'node_modules', 'a'))).toBe(true);
  });

  it('boot recovery resolves a row left building by a killed runner', () => {
    const store = makeMemoryStore();
    store.insertBuilding('p1', 'stuck-hash');
    expect(store.listBuilding()).toHaveLength(1);
    recoverInterruptedDependencyCacheBuilds(store);
    expect(store.listBuilding()).toHaveLength(0);
    expect(store.rows.get('p1:stuck-hash')?.status).toBe('failed');
    expect(store.getReady('p1', 'stuck-hash')).toBeUndefined();
  });
});
