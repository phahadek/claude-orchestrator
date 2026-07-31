import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveDbPath } from '../resolveDbPath.js';

describe('resolveDbPath', () => {
  it('resolves a relative path against the data directory, not process.cwd()', () => {
    const dataDir = '/srv/orchestrator/data';
    expect(resolveDbPath('./dashboard.db', dataDir)).toBe(
      path.join(dataDir, 'dashboard.db'),
    );
    expect(resolveDbPath('dashboard.db', dataDir)).toBe(
      path.join(dataDir, 'dashboard.db'),
    );
  });

  it('leaves an absolute path untouched', () => {
    const dataDir = '/srv/orchestrator/data';
    expect(resolveDbPath('/var/lib/dashboard.db', dataDir)).toBe(
      '/var/lib/dashboard.db',
    );
  });

  it('leaves ":memory:" untouched', () => {
    expect(resolveDbPath(':memory:', '/srv/orchestrator/data')).toBe(
      ':memory:',
    );
  });
});
