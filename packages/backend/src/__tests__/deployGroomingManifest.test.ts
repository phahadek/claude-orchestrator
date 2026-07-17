import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

describe('deploy-grooming.mjs manifest', () => {
  it('vendors the five route clients and drops the retired loaders (dry-run)', () => {
    const output = execFileSync(
      process.execPath,
      [resolve(repoRoot, 'scripts/deploy-grooming.mjs'), '--dry-run'],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    for (const client of [
      'scripts/ops-client.mjs',
      'packages/backend/scripts/groom-context-client.mjs',
      'packages/backend/scripts/gate-state-client.mjs',
      'packages/backend/scripts/seed-state-client.mjs',
      'packages/backend/scripts/stage-task-intent.mjs',
      'skills/gate/',
    ]) {
      expect(output).toContain(client);
    }

    for (const retired of [
      'groom-load.mjs',
      'ops-load.mjs',
      'ops-journal-set.mjs',
      'groom-gate.mjs',
    ]) {
      expect(output).not.toContain(retired);
    }
  });
});
