import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Guard test for the idle-is-not-terminal invariant (see db/queries.ts's
 * TERMINAL_SESSION_STATUSES doc comment). idle is an active-but-waiting
 * session status — a session parked idle can be resumed at any moment and
 * has not concluded — so it must never be classified as terminal anywhere
 * in the codebase. Scans every backend source file for a status
 * array/set/SQL-list literal that lists 'idle' alongside 'done' and
 * 'killed' (the concrete shape the conflation bug took: idle buried among
 * genuinely-concluded statuses).
 */

const SRC_ROOT = path.join(__dirname, '..');

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      files.push(full);
    }
  }
  return files;
}

describe('terminal status vocabulary guard', () => {
  it("never lists 'idle' alongside 'done' and 'killed' in the same status collection literal", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const content = fs.readFileSync(file, 'utf8');
      const collectionRegex = /\[[^[\]]*\]|\([^()]*\)/g;
      let match: RegExpExecArray | null;
      while ((match = collectionRegex.exec(content))) {
        const chunk = match[0];
        if (
          chunk.includes("'done'") &&
          chunk.includes("'killed'") &&
          chunk.includes("'idle'")
        ) {
          offenders.push(
            `${path.relative(SRC_ROOT, file)}: ${chunk.slice(0, 160)}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the canonical TERMINAL_SESSION_STATUSES set does not contain idle', async () => {
    const { TERMINAL_SESSION_STATUSES } = await import('../db/queries');
    expect(TERMINAL_SESSION_STATUSES.has('idle')).toBe(false);
    expect([...TERMINAL_SESSION_STATUSES].sort()).toEqual([
      'done',
      'error',
      'killed',
    ]);
  });
});
