import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

describe('sync-guidelines-load.mjs vendor plan', () => {
  it('covers the six route clients, all seven skills, and drops the retired loaders', () => {
    const output = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts/sync-guidelines-load.mjs'),
        '--json',
        '--repo',
        repoRoot,
        '--config-dir',
        resolve(repoRoot, '.non-existent-config-dir'),
        '--claude-home',
        resolve(repoRoot, '.non-existent-claude-home'),
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const { plan } = JSON.parse(output);
    const ids = plan.map((p: { id: string }) => p.id);

    for (const id of [
      'script:ops-client.mjs',
      'script:groom-context-client.mjs',
      'script:gate-state-client.mjs',
      'script:seed-state-client.mjs',
      'script:stage-task-intent.mjs',
      'script:staged-intents-client.mjs',
      'skill:groom',
      'skill:design',
      'skill:ops',
      'skill:deploy',
      'skill:wrap',
      'skill:sync-guidelines',
      'skill:gate',
    ]) {
      expect(ids).toContain(id);
    }

    for (const retired of [
      'groom-load.mjs',
      'ops-load.mjs',
      'ops-journal-set.mjs',
      'groom-gate.mjs',
    ]) {
      expect(ids.some((id: string) => id.includes(retired))).toBe(false);
    }
  });

  it('never force-overwrites: no cpSync with force:true anywhere in the loader', () => {
    const source = readFileSync(
      resolve(repoRoot, 'scripts/sync-guidelines-load.mjs'),
      'utf8',
    );
    expect(source).not.toMatch(/cpSync/);
    expect(source).not.toMatch(/force:\s*true/);
  });
});
