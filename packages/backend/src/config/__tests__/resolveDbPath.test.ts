import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveDbPath, resolveLegacyDbCandidates } from '../resolveDbPath.js';

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

describe('resolveLegacyDbCandidates', () => {
  it('returns the cwd-relative and backend-package-relative candidates for a relative path', () => {
    const backendPackageRoot = '/srv/orchestrator/packages/backend';
    const candidates = resolveLegacyDbCandidates(
      './dashboard.db',
      backendPackageRoot,
    );
    expect(candidates).toContain(path.join(process.cwd(), 'dashboard.db'));
    expect(candidates).toContain(path.join(backendPackageRoot, 'dashboard.db'));
  });

  it('returns no candidates for an absolute path', () => {
    expect(
      resolveLegacyDbCandidates(
        '/var/lib/dashboard.db',
        '/srv/orchestrator/packages/backend',
      ),
    ).toEqual([]);
  });

  it('returns no candidates for ":memory:"', () => {
    expect(
      resolveLegacyDbCandidates(
        ':memory:',
        '/srv/orchestrator/packages/backend',
      ),
    ).toEqual([]);
  });
});
