import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetForTesting, setupSessionCgroup } from './sessionCgroup';

describe('setupSessionCgroup subtree_control', () => {
  const OWN = '/sys/fs/cgroup/system.slice/orch.service';
  let writes: Array<[string, string]>;

  beforeEach(() => {
    writes = [];
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: string) => {
      if (p === '/proc/self/cgroup') return '0::/system.slice/orch.service\n';
      if (p.endsWith('cgroup.controllers')) return 'cpu io memory pids';
      return '';
    }) as typeof fs.readFileSync);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      p: string,
      data: string,
    ) => {
      writes.push([String(p), String(data)]);
    }) as typeof fs.writeFileSync);
  });

  afterEach(() => {
    _resetForTesting();
    vi.restoreAllMocks();
  });

  it('enables +memory on tests/ and sessions/ subtree_control', () => {
    setupSessionCgroup();
    for (const leaf of ['tests', 'sessions']) {
      const w = writes.find(
        ([p]) => p === `${OWN}/${leaf}/cgroup.subtree_control`,
      );
      expect(w).toBeDefined();
      expect(w?.[1]).toContain('+memory');
    }
  });
});
