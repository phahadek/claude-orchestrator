import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../db/queries.js', () => ({
  getSetting: () => undefined,
  setSetting: () => {},
}));

import { getCorporateMode } from '../corporateMode';

/**
 * Every key declared on CorporateModeGates must be consulted somewhere in
 * production code as `gates.<key>` (or `.gates.<key>`) — otherwise setting
 * its per-gate env override has no effect (the class of bug this guards
 * against: a gate declared but wired to nothing).
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (
      entry.isFile() &&
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
    ) {
      results.push(full);
    }
  }
  return results;
}

describe('corporate-mode gate wiring', () => {
  it('every declared gate has at least one non-test production consumer', () => {
    const srcDir = path.join(__dirname, '..', '..');
    const files = collectSourceFiles(srcDir);
    const combinedSource = files
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');

    const gateKeys = Object.keys(getCorporateMode().gates);
    expect(gateKeys.length).toBeGreaterThan(0);

    for (const key of gateKeys) {
      const pattern = new RegExp(`\\.gates\\.${key}\\b`);
      expect(
        pattern.test(combinedSource),
        `gate "${key}" is declared but has no production consumer of the form gates.${key}`,
      ).toBe(true);
    }
  });
});
