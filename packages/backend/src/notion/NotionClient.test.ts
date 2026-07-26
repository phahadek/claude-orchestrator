import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Stub modules with side effects so NotionClient.ts can be imported without
// a real database connection or environment variables.
vi.mock('../config', () => ({
  config: { notionApiKey: 'test', notionDatabaseId: 'test', port: 3000 },
}));
vi.mock('../db/queries', () => ({
  getGrantedCapabilities: vi.fn(() => []),
  upsertTaskCache: vi.fn(),
  getCacheAge: vi.fn(() => Infinity),
  getTaskCache: vi.fn(() => null),
  updateTaskCacheStatus: vi.fn(),
  deleteTaskCacheRow: vi.fn(),
}));

import {
  parseSection,
  parseDependsOn,
  parseExpectedSize,
  blockToLine,
  NotionClient,
} from './NotionClient';
import {
  updateTaskCacheStatus,
  getCacheAge,
  getTaskCache,
} from '../db/queries';

const source = fs.readFileSync(
  path.join(__dirname, 'NotionClient.ts'),
  'utf-8',
);

describe('NotionClient.fetchReadyTasks() — Notion query filter', () => {
  it('includes Deferred tasks in the board fetch (no does_not_equal filter for Deferred)', () => {
    // Deferred tasks must be returned so DependencyResolver can surface them as blockers.
    expect(source).not.toMatch(
      /does_not_equal.*Deferred|Deferred.*does_not_equal/,
    );
  });

  it('does not restrict to a hard-coded allowlist of statuses (no or-filter with equals)', () => {
    // There must be no allowlist — all statuses including Deferred must be fetched.
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

describe('blockToLine()', () => {
  it('renders a heading_4 block with a #### prefix', () => {
    const line = blockToLine({
      type: 'heading_4',
      heading_4: { rich_text: [{ plain_text: 'Add env var [notion:src-a]' }] },
    });
    expect(line).toBe('#### Add env var [notion:src-a]');
  });

  it('renders a to_do block with a - prefix, regardless of checked state', () => {
    const unchecked = blockToLine({
      type: 'to_do',
      to_do: {
        rich_text: [{ plain_text: 'Verify the thing' }],
        checked: false,
      },
    });
    const checked = blockToLine({
      type: 'to_do',
      to_do: {
        rich_text: [{ plain_text: 'Confirm the thing' }],
        checked: true,
      },
    });
    expect(unchecked).toBe('- Verify the thing');
    expect(checked).toBe('- Confirm the thing');
  });
});

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

  it('createTask always sets Status to 🔲 Backlog regardless of input fields', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'new-id',
        url: 'https://notion.so/new-id',
        properties: {
          'Task Name': { type: 'title', title: [{ text: { content: 'X' } }] },
          Status: { type: 'select', select: { name: '🔲 Backlog' } },
          Type: { type: 'select', select: null },
          'Depends On': { type: 'rich_text', rich_text: [] },
          Notes: { type: 'rich_text', rich_text: [] },
        },
      }),
    });

    await client.createTask('db-1', {
      title: 'New task',
      // Even a caller who somehow slips a status-like field through must not
      // influence the persisted status — createTask's fields type has no
      // status field at all, so this is enforced entirely by omission.
    });

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.properties.Status).toEqual({ select: { name: '🔲 Backlog' } });
    expect(body.parent).toEqual({ database_id: 'db-1' });
  });

  it('createTask encodes dependsOn as a pipe-delimited Depends On rich_text', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'new-id',
        url: 'https://notion.so/new-id',
        properties: {
          'Task Name': { type: 'title', title: [{ text: { content: 'X' } }] },
          Status: { type: 'select', select: { name: '🔲 Backlog' } },
          Type: { type: 'select', select: null },
          'Depends On': { type: 'rich_text', rich_text: [] },
          Notes: { type: 'rich_text', rich_text: [] },
        },
      }),
    });

    await client.createTask('db-1', {
      title: 'New task',
      dependsOn: ['notion:dep1', 'notion:dep2'],
    });

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.properties['Depends On']).toEqual({
      rich_text: [{ text: { content: 'dep1|dep2' } }],
    });
  });

  it('setDependsOn writes a pipe-delimited Depends On rich_text at /pages/abc', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({}) });

    await client.setDependsOn('notion:abc', ['notion:dep1', 'notion:dep2']);

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/pages/abc');
    expect(url).not.toContain('notion:abc');
    const body = JSON.parse(options.body as string);
    expect(body.properties['Depends On']).toEqual({
      rich_text: [{ text: { content: 'dep1|dep2' } }],
    });
  });

  it('setDependsOn round-trips through parseDependsOn', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({}) });

    await client.setDependsOn('notion:abc', ['notion:dep1', 'notion:dep2']);

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    const written = body.properties['Depends On'].rich_text[0].text.content;
    expect(parseDependsOn(written)).toEqual(['dep1', 'dep2']);
  });

  it('archive PATCHes { archived: true } at /pages/abc (not /pages/notion:abc)', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({}) });

    await client.archive('notion:abc');

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/pages/abc');
    expect(url).not.toContain('notion:abc');
    expect(options.method).toBe('PATCH');
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({ archived: true });
  });
});

// ─── NotionClient.patchBodySection() — heading-bounded block engine ────────

describe('NotionClient.patchBodySection()', () => {
  let client: NotionClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  // Fixture page: Summary -> Context (two paragraphs) -> Files (one paragraph).
  function fixtureChildren() {
    return [
      { id: 'h-summary', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Summary' }] } },
      { id: 'p-summary', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Summary text' }] } },
      { id: 'h-context', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Context' }] } },
      { id: 'p-context-1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Context line 1' }] } },
      { id: 'p-context-2', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Context line 2' }] } },
      { id: 'h-files', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Files' }] } },
      { id: 'p-files', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'file a' }] } },
    ];
  }

  function mockChildrenFetch() {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: fixtureChildren(),
        has_more: false,
        next_cursor: null,
      }),
    });
  }

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    client = new NotionClient();
  });

  it('append inserts new blocks right after the section\'s last block', async () => {
    mockChildrenFetch();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [{ id: 'new-1' }] }),
    });

    await client.patchBodySection('notion:abc', 'Context', {
      operation: 'append',
      content: 'A new context line',
    });

    const [url, options] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/blocks/abc/children');
    const body = JSON.parse(options.body as string);
    expect(body.after).toBe('p-context-2');
    expect(body.children[0].paragraph.rich_text[0].text.content).toBe(
      'A new context line',
    );
  });

  it('append auto-creates an absent section (heading + content) at the page end', async () => {
    mockChildrenFetch();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [{ id: 'new-heading' }, { id: 'new-1' }] }),
    });

    await client.patchBodySection('notion:abc', 'Open Questions', {
      operation: 'append',
      content: 'None.',
    });

    const [, options] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.after).toBeUndefined();
    expect(body.children[0].type).toBe('heading_2');
    expect(body.children[0].heading_2.rich_text[0].text.content).toBe(
      'Open Questions',
    );
  });

  it('replace substitutes find/replaceWith against the section text, inserts before deleting', async () => {
    mockChildrenFetch();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [{ id: 'new-1' }, { id: 'new-2' }] }),
    });
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // delete p-context-1
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // delete p-context-2

    await client.patchBodySection('notion:abc', 'Context', {
      operation: 'replace',
      find: 'line 1',
      replaceWith: 'LINE ONE',
    });

    const insertCall = fetchSpy.mock.calls[1] as [string, RequestInit];
    const insertBody = JSON.parse(insertCall[1].body as string);
    expect(insertBody.after).toBe('p-context-2');
    const renderedText = insertBody.children
      .map((b: { paragraph: { rich_text: { text: { content: string } }[] } }) =>
        b.paragraph.rich_text[0].text.content,
      )
      .join('\n');
    expect(renderedText).toContain('LINE ONE');
    expect(renderedText).not.toContain('line 1');

    const deleteCalls = fetchSpy.mock.calls.slice(2);
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0][0]).toContain('/blocks/p-context-1');
    expect(deleteCalls[1][0]).toContain('/blocks/p-context-2');
  });

  it('replace fails explicitly when the section does not exist', async () => {
    mockChildrenFetch();

    await expect(
      client.patchBodySection('notion:abc', 'Nonexistent', {
        operation: 'replace',
        find: 'x',
        replaceWith: 'y',
      }),
    ).rejects.toThrow(/section "Nonexistent" not found/);
  });

  it('replace fails explicitly when the find text is not present in the section', async () => {
    mockChildrenFetch();

    await expect(
      client.patchBodySection('notion:abc', 'Context', {
        operation: 'replace',
        find: 'no such text',
        replaceWith: 'y',
      }),
    ).rejects.toThrow(/text to replace not found/);
  });

  it('remove deletes every block in the section plus the heading', async () => {
    mockChildrenFetch();
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // delete p-files
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // delete h-files

    await client.patchBodySection('notion:abc', 'Files', { operation: 'remove' });

    expect(fetchSpy.mock.calls[1][0]).toContain('/blocks/p-files');
    expect(fetchSpy.mock.calls[2][0]).toContain('/blocks/h-files');
  });

  it('remove on an already-absent section is a no-op', async () => {
    mockChildrenFetch();

    await client.patchBodySection('notion:abc', 'Nonexistent', {
      operation: 'remove',
    });

    // Only the initial children fetch — no delete calls issued.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── NotionClient.readBoardCache — prefix-stripping on cache-hit ──────────────

describe('NotionClient.fetchReadyTasks — readBoardCache strips notion: prefix', () => {
  const BOARD_ID_STRIP = 'strip-test-board-id';
  const RAW_TASK_ID = 'aaaa1111-bbbb-2222-cccc-ddddeeeeeeee';
  const PREFIXED_TASK_ID = `notion:${RAW_TASK_ID}`;

  let client: NotionClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(getCacheAge).mockReset();
    vi.mocked(getTaskCache).mockReset();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    client = new NotionClient();
  });

  it('returns raw IDs when board cache contains notion:-prefixed IDs', async () => {
    vi.mocked(getCacheAge).mockReturnValue(0);
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: `board:${BOARD_ID_STRIP}`,
      fetched_at: Date.now(),
      raw_json: JSON.stringify([
        {
          id: PREFIXED_TASK_ID,
          title: 'Task A',
          status: '🗂️ Ready',
          type: '💻 Code',
          dependsOn: [],
          notionUrl: 'https://notion.so/x',
          priority: '',
        },
      ]),
    });

    const tasks = await client.fetchReadyTasks(BOARD_ID_STRIP);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task.id).toBe(RAW_TASK_ID);
    expect(tasks[0].task.id).not.toContain('notion:');
  });

  it('leaves raw IDs unchanged when board cache has no prefix', async () => {
    vi.mocked(getCacheAge).mockReturnValue(0);
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: `board:${BOARD_ID_STRIP}`,
      fetched_at: Date.now(),
      raw_json: JSON.stringify([
        {
          id: RAW_TASK_ID,
          title: 'Task A',
          status: '🗂️ Ready',
          type: '💻 Code',
          dependsOn: [],
          notionUrl: 'https://notion.so/x',
          priority: '',
        },
      ]),
    });

    const tasks = await client.fetchReadyTasks(BOARD_ID_STRIP);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tasks[0].task.id).toBe(RAW_TASK_ID);
  });

  it('strips notion: prefix from dependsOn entries when board cache has prefixed-everywhere shape', async () => {
    const DEP_RAW = 'bbbb2222-cccc-3333-dddd-eeeeffffffff';
    const DEP_PREFIXED = `notion:${DEP_RAW}`;
    vi.mocked(getCacheAge).mockReturnValue(0);
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: `board:${BOARD_ID_STRIP}`,
      fetched_at: Date.now(),
      raw_json: JSON.stringify([
        {
          id: PREFIXED_TASK_ID,
          title: 'Task A',
          status: '🗂️ Ready',
          type: '💻 Code',
          dependsOn: [DEP_PREFIXED],
          notionUrl: 'https://notion.so/x',
          priority: '',
        },
        {
          id: DEP_PREFIXED,
          title: 'Task B',
          status: '🗂️ Ready',
          type: '💻 Code',
          dependsOn: [],
          notionUrl: 'https://notion.so/y',
          priority: '',
        },
      ]),
    });

    const tasks = await client.fetchReadyTasks(BOARD_ID_STRIP);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tasks[0].task.dependsOn).toEqual([DEP_RAW]);
    expect(tasks[0].task.dependsOn[0]).not.toContain('notion:');
  });

  it('leaves raw dependsOn entries unchanged when board cache has no prefix', async () => {
    const DEP_RAW = 'bbbb2222-cccc-3333-dddd-eeeeffffffff';
    vi.mocked(getCacheAge).mockReturnValue(0);
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: `board:${BOARD_ID_STRIP}`,
      fetched_at: Date.now(),
      raw_json: JSON.stringify([
        {
          id: RAW_TASK_ID,
          title: 'Task A',
          status: '🗂️ Ready',
          type: '💻 Code',
          dependsOn: [DEP_RAW],
          notionUrl: 'https://notion.so/x',
          priority: '',
        },
      ]),
    });

    const tasks = await client.fetchReadyTasks(BOARD_ID_STRIP);

    expect(tasks[0].task.dependsOn).toEqual([DEP_RAW]);
  });
});
