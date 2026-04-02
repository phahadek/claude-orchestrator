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
