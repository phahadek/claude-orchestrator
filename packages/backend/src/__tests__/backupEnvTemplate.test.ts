import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../..');

describe('backup.env.example parity', () => {
  it('lists exactly the env vars scripts/backup-database.mjs reads', () => {
    const script = readFileSync(
      join(REPO_ROOT, 'scripts/backup-database.mjs'),
      'utf8',
    );
    const scriptVars = new Set(
      [...script.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]),
    );

    const template = readFileSync(
      join(REPO_ROOT, 'installers/linux/backup.env.example'),
      'utf8',
    );
    const templateVars = new Set(
      [...template.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]),
    );

    expect(templateVars).toEqual(scriptVars);
  });
});
