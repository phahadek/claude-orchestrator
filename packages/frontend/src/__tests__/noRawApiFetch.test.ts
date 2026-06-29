// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const FRONTEND_SRC = join(__dirname, '..');

// api/projects.ts is the wrapper module — raw fetch('/api/...) calls inside it are intentional
const EXEMPT_FILES = new Set([join(FRONTEND_SRC, 'api', 'projects.ts')]);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && !entry.startsWith('.')) {
        files.push(...walk(full));
      }
    } else if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.spec.tsx')
    ) {
      files.push(full);
    }
  }
  return files;
}

// Matches fetch( immediately followed by optional whitespace then a quote starting /api
// Catches both same-line and multi-line patterns like:
//   fetch('/api/...')
//   fetch(`/api/...`)
//   fetch(
//     `/api/...`)
const RAW_API_FETCH = /fetch\s*\(\s*['"`]\/api/;

describe('no-raw-api-fetch guard', () => {
  it('has no raw fetch([\'/api/...]) calls outside api/projects.ts', () => {
    const files = walk(FRONTEND_SRC).filter((f) => !EXEMPT_FILES.has(f));
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (RAW_API_FETCH.test(content)) {
        violations.push(relative(FRONTEND_SRC, file));
      }
    }

    expect(
      violations,
      `Raw fetch('/api/...') calls found outside the authedFetch wrapper — route through authedFetch:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
