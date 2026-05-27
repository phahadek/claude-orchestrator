import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Stub modules with side effects so NotionClient.ts can be imported without
// a real database connection or environment variables.
vi.mock('../config', () => ({
  config: { notionApiKey: 'test', notionDatabaseId: 'test', port: 3000 },
}));
vi.mock('../db/queries', () => ({
  upsertTaskCache: vi.fn(),
  getCacheAge: vi.fn(() => Infinity),
  getTaskCache: vi.fn(() => null),
  updateTaskCacheStatus: vi.fn(),
}));

import {
  parseSection,
  parseDependsOn,
  parseExpectedSize,
  NotionClient,
} from './NotionClient';
import { updateTaskCacheStatus } from '../db/queries';

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

// ─── parseDependsOn unit tests ───────────────────────────────────────────────

describe('parseDependsOn()', () => {
  it('splits a pipe-delimited list (canonical)', () => {
    expect(parseDependsOn('abc123|def456')).toEqual(['abc123', 'def456']);
  });

  it('splits a comma-delimited list (accepted leniently)', () => {
    expect(parseDependsOn('abc123,def456')).toEqual(['abc123', 'def456']);
  });

  it('splits a mixed pipe/comma list', () => {
    expect(parseDependsOn('abc123|def456,ghi789')).toEqual([
      'abc123',
      'def456',
      'ghi789',
    ]);
  });

  it('trims whitespace around delimiters', () => {
    expect(parseDependsOn(' abc123 | def456 , ghi789 ')).toEqual([
      'abc123',
      'def456',
      'ghi789',
    ]);
  });

  it('resolves a single ID with no delimiter to one entry', () => {
    expect(parseDependsOn('abc123')).toEqual(['abc123']);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseDependsOn('')).toEqual([]);
  });

  it('drops empty segments produced by stray delimiters', () => {
    expect(parseDependsOn('abc123,,def456|')).toEqual(['abc123', 'def456']);
  });
});

// ─── parseExpectedSize unit tests ────────────────────────────────────────────

describe('parseExpectedSize()', () => {
  it('returns undefined when the section is absent', () => {
    expect(parseExpectedSize(SAMPLE_MD)).toBeUndefined();
  });

  it('returns the numeric value from a top-level Expected size section', () => {
    const md = `## Expected size\n1500\n\n## Summary\nbody`;
    expect(parseExpectedSize(md)).toBe(1500);
  });

  it('does not bleed into adjacent sections when Summary follows', () => {
    const md = `## Expected size\n1500\n\n## Summary\nThis is the summary.`;
    expect(parseSection(md, 'summary')).toBe('This is the summary.');
    expect(parseSection(md, 'expected size')).toBe('1500');
  });

  it('ignores zero/negative values (treated as unset)', () => {
    expect(parseExpectedSize(`## Expected size\n0\n`)).toBeUndefined();
    expect(parseExpectedSize(`## Expected size\n-100\n`)).toBeUndefined();
  });

  it('returns undefined when the section is empty or non-numeric', () => {
    expect(
      parseExpectedSize(`## Expected size\n\n## Summary\nx`),
    ).toBeUndefined();
    expect(parseExpectedSize(`## Expected size\nlarge\n`)).toBeUndefined();
  });
});

// ─── NotionClient prefix-stripping tests ─────────────────────────────────────

describe('NotionClient — prefix stripping in public methods', () => {
  let client: NotionClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(updateTaskCacheStatus).mockReset();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    client = new NotionClient();
  });

  it('updateStatus calls Notion API at /pages/abc (not /pages/notion:abc)', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await client.updateStatus('notion:abc', '✅ Done');

    const [url] = fetchSpy.mock.calls[0] as [string, unknown];
    expect(url).toContain('/pages/abc');
    expect(url).not.toContain('notion:abc');
  });

  it('updateStatus updates task_cache keyed notion:abc (not abc)', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await client.updateStatus('notion:abc', '✅ Done');

    expect(vi.mocked(updateTaskCacheStatus)).toHaveBeenCalledWith(
      'notion:abc',
      '✅ Done',
    );
    expect(vi.mocked(updateTaskCacheStatus)).not.toHaveBeenCalledWith(
      'abc',
      expect.anything(),
    );
  });

  it('fetchTaskPage calls Notion API at /pages/abc (not /pages/notion:abc)', async () => {
    const mockPage = {
      id: 'abc',
      url: 'https://notion.so/abc',
      properties: {
        'Task Name': { type: 'title', title: [{ text: { content: 'Test' } }] },
        Status: { type: 'select', select: null },
        Type: { type: 'select', select: null },
        'Depends On': { type: 'rich_text', rich_text: [] },
        Notes: { type: 'rich_text', rich_text: [] },
      },
    };
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => mockPage })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [], has_more: false, next_cursor: null }),
      });

    await client.fetchTaskPage('notion:abc');

    const firstUrl = fetchSpy.mock.calls[0][0] as string;
    expect(firstUrl).toContain('/pages/abc');
    expect(firstUrl).not.toContain('notion:abc');
  });
});
