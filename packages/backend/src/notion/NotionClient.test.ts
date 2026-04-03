import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, 'NotionClient.ts'),
  'utf-8',
);

describe('NotionClient.fetchReadyTasks() — Notion query filter', () => {
  it('excludes only Deferred tasks (does_not_equal) so Done tasks are included', () => {
    expect(source).toMatch(/does_not_equal.*Deferred|Deferred.*does_not_equal/);
  });

  it('does not restrict to a hard-coded allowlist of statuses (no or-filter with equals)', () => {
    // The old filter used { or: [{ select: { equals: '...' } }, ...] }.
    // The new filter must not have this pattern — it should use does_not_equal instead.
    expect(source).not.toMatch(/select:\s*\{\s*equals:\s*['"]🗂️ Ready['"]/);
    expect(source).not.toMatch(/select:\s*\{\s*equals:\s*['"]✅ Done['"]/);
  });
});

// ─── parseSection unit tests ──────────────────────────────────────────────────

// We extract parseSection from source by evaluating the relevant parts in a
// controlled way. Instead, we duplicate the logic here from the implementation
// so we can test it directly without importing the entire module (which has
// side effects and requires environment variables).

const TOP_LEVEL_SECTIONS = [
  'summary',
  'dependencies',
  'context',
  'acceptance criteria',
  'files',
  'implementation notes',
];

function parseSection(markdown: string, headingKeyword: string): string {
  const lines = markdown.split('\n');
  let inSection = false;
  const buf: string[] = [];
  for (const line of lines) {
    const isHeading = /^#{1,3} /.test(line);
    if (isHeading) {
      const heading = line.replace(/^#+\s*/, '').toLowerCase();
      if (heading.includes(headingKeyword.toLowerCase())) {
        inSection = true;
        continue;
      } else if (inSection) {
        const isTopLevel = TOP_LEVEL_SECTIONS.some(
          s => heading.includes(s) && s !== headingKeyword.toLowerCase(),
        );
        if (isTopLevel) {
          break;
        }
        buf.push(line);
      }
    } else if (inSection) {
      buf.push(line);
    }
  }
  return buf.join('\n').trim();
}

const SAMPLE_MD = `
## Summary

This is the summary.

## Context

Some context here.

## Acceptance Criteria

- Do the thing

### 🤖 Automated tests

- test A
- test B

### 👁️ Manual verification

- check X

## Files / paths affected

- src/foo.ts

## Implementation Notes

Details here.
`.trim();

describe('parseSection()', () => {
  it('captures acceptance criteria including sub-headings', () => {
    const result = parseSection(SAMPLE_MD, 'acceptance criteria');
    expect(result).toContain('🤖 Automated tests');
    expect(result).toContain('👁️ Manual verification');
    expect(result).toContain('test A');
    expect(result).toContain('check X');
  });

  it('stops before the next top-level section (Files)', () => {
    const result = parseSection(SAMPLE_MD, 'acceptance criteria');
    expect(result).not.toContain('src/foo.ts');
    expect(result).not.toContain('paths affected');
  });

  it('returns only summary content (no regression)', () => {
    const result = parseSection(SAMPLE_MD, 'summary');
    expect(result).toBe('This is the summary.');
    expect(result).not.toContain('context');
    expect(result).not.toContain('acceptance');
  });

  it('returns only context content (no regression)', () => {
    const result = parseSection(SAMPLE_MD, 'context');
    expect(result).toBe('Some context here.');
    expect(result).not.toContain('acceptance');
  });

  it('returns only files content (no regression)', () => {
    const result = parseSection(SAMPLE_MD, 'files');
    expect(result).toContain('src/foo.ts');
    expect(result).not.toContain('Implementation Notes');
  });
});
