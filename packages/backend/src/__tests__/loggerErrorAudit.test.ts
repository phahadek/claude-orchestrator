import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_DIR = path.join(__dirname, '..');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Matches `logger.<level>(<msg>, <errIdentifier>)` — a caught Error (or
// Error-like value) passed as the raw second argument, with no manual
// extraction beforehand. This is the exact shape that used to serialize to
// `{}` via JSON.stringify before logger.ts's write() learned to unwrap
// Error arguments centrally.
const RAW_ERROR_CALL_SITE =
  /logger\.(error|warn|info|debug)\(\s*[^,]*,\s*(err|error|e|cause)\s*,?\s*\)/gs;

// The one pattern that would defeat the central unwrap: pre-serializing the
// Error to JSON text before it ever reaches write(), which reproduces the
// `{}` bug at the call site regardless of what logger.ts does.
const MANUAL_STRINGIFY_BYPASS =
  /logger\.(error|warn|info|debug)\([^;]*?JSON\.stringify\(\s*(err|error|e|cause)\b/gs;

describe('repository audit: logger call sites do not serialize Errors to {}', () => {
  const files = listTsFiles(SRC_DIR).filter((f) => !f.includes('__tests__'));

  it('scanned a non-trivial number of backend source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('finds the known population of raw-Error logger call sites (regression canary)', () => {
    let count = 0;
    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf8');
      const matches = contents.match(RAW_ERROR_CALL_SITE);
      count += matches?.length ?? 0;
    }
    // Confirms this audit actually inspects real call sites (the task's
    // grooming audit found ~13+); if this drops to 0, the regex broke.
    expect(count).toBeGreaterThan(10);
  });

  it('no call site manually JSON.stringifies a caught Error before logging it', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf8');
      if (MANUAL_STRINGIFY_BYPASS.test(contents)) {
        offenders.push(path.relative(SRC_DIR, file));
      }
      MANUAL_STRINGIFY_BYPASS.lastIndex = 0;
    }
    expect(offenders).toEqual([]);
  });
});
