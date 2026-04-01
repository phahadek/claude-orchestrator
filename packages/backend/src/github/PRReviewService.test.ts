import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../config.js', () => ({
  config: { claudePath: 'claude', projectDir: '/test/project' },
  ALLOWED_TOOLS: ['Bash(git:*)', 'Bash(npm:*)', 'mcp__github__*'],
}));

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  setPRReviewResult: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { PRReviewService } from './PRReviewService.js';
import { ALLOWED_TOOLS } from '../config.js';
import { getPRByNumber, setPRReviewResult } from '../db/queries.js';
import { spawn } from 'child_process';
import type { GitHubClient } from './GitHubClient.js';
import type { NotionClient } from '../notion/NotionClient.js';
import type { PullRequest, PRDiff } from './types.js';
import type { NotionTaskPage } from '../notion/NotionClient.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const mockPR: PullRequest = {
  id: 42,
  title: 'feat: add something cool',
  body: 'This PR implements the something cool feature',
  url: 'https://github.com/owner/repo/pull/42',
  apiUrl: 'https://api.github.com/repos/owner/repo/pulls/42',
  headBranch: 'feature/something-cool',
  baseBranch: 'dev',
  state: 'open',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T01:00:00Z',
  mergeableState: 'clean',
  draft: false,
};

const mockDiff: PRDiff = {
  prId: 42,
  diff: 'diff --git a/src/foo.ts b/src/foo.ts\nindex abc..def 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,2 @@\n export const foo = 1;\n+export const bar = 2;\n',
  filesChanged: ['src/foo.ts'],
};

const mockTask: NotionTaskPage = {
  taskId: 'task-abc123',
  name: 'Add something cool',
  summarySection: 'Implement the something cool feature for users',
  contextSection: 'The implementation should add bar export to foo.ts using the existing pattern',
  acceptanceCriteria: '- [ ] bar export is added\n- [ ] tsc passes',
  filesSection: '- src/foo.ts (update)',
  rawMarkdown: '## Summary\nImplement...\n## Context\n...\n## Acceptance Criteria\n...\n## Files\n...',
};

const mockPRRow = {
  id: 1,
  pr_number: 42,
  pr_url: 'https://github.com/owner/repo/pull/42',
  notion_task_id: 'task-abc123',
  session_id: 'session-xyz',
  repo: 'owner/repo',
  title: 'feat: add something cool',
  body: null,
  head_branch: 'feature/something-cool',
  base_branch: 'dev',
  state: 'open',
  review_result: null,
  review_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T01:00:00Z',
  synced_at: '2024-01-01T01:00:00Z',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockGitHub(): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([mockPR]),
    fetchDiff: vi.fn().mockResolvedValue(mockDiff),
    mergePR: vi.fn(),
  } as unknown as GitHubClient;
}

function makeMockNotion(): NotionClient {
  return {
    fetchTaskPage: vi.fn().mockResolvedValue(mockTask),
    fetchReadyTasks: vi.fn(),
    updateStatus: vi.fn(),
    attachPR: vi.fn(),
  } as unknown as NotionClient;
}

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: { write: vi.fn(), end: vi.fn(), writable: true },
    kill: vi.fn(),
  });
  return { proc, stdout };
}

/** Push an assistant event with the given text content, then signal EOF + exit. */
function emitClaudeText(stdout: Readable, proc: EventEmitter, text: string): void {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
  stdout.push(line + '\n');
  stdout.push(null);
  proc.emit('exit', 0);
}

/** Flush pending microtasks by yielding the event loop multiple times. */
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── buildPrompt() ─────────────────────────────────────────────────────────────

describe('PRReviewService.buildPrompt()', () => {
  it('includes PR diff, all four Notion spec sections, and the JSON schema instruction', () => {
    const service = new PRReviewService(makeMockGitHub(), makeMockNotion());
    const prompt = service.buildPrompt(mockPR, mockDiff, mockTask);

    // PR data
    expect(prompt).toContain(mockPR.title);
    expect(prompt).toContain(mockDiff.diff);

    // All four Notion spec sections
    expect(prompt).toContain(mockTask.summarySection);
    expect(prompt).toContain(mockTask.contextSection);
    expect(prompt).toContain(mockTask.acceptanceCriteria);
    expect(prompt).toContain(mockTask.filesSection);

    // JSON schema instruction with the four named dimensions
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"dimensions"');
    expect(prompt).toContain('Title and description vs task Summary');
    expect(prompt).toContain('Diff vs Context spec');
    expect(prompt).toContain('Diff vs Acceptance Criteria');
    expect(prompt).toContain('Changed files vs Files/paths affected list');
  });

  it('truncates diffs longer than 12000 characters and appends a truncation notice', () => {
    const longDiff: PRDiff = { ...mockDiff, diff: 'A'.repeat(13000) };
    const service = new PRReviewService(makeMockGitHub(), makeMockNotion());
    const prompt = service.buildPrompt(mockPR, longDiff, mockTask);

    expect(prompt).toContain('[diff truncated');
    // The full 13000-char diff must NOT appear verbatim
    expect(prompt).not.toContain('A'.repeat(13000));
  });
});

// ── reviewPR() success path ───────────────────────────────────────────────────

describe('PRReviewService.reviewPR() — success', () => {
  it('calls setPRReviewResult with prNumber and repo after a successful run', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    const { proc, stdout } = createMockProc();
    vi.mocked(spawn).mockReturnValue(proc as any);

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion());
    const resultPromise = service.reviewPR(42, 'owner/repo');

    const claudePayload = {
      verdict: 'approved',
      dimensions: [
        { name: 'Title and description vs task Summary', passed: true, notes: 'Matches.' },
        { name: 'Diff vs Context spec', passed: true, notes: 'Matches.' },
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'Matches.' },
        { name: 'Changed files vs Files/paths affected list', passed: true, notes: 'Matches.' },
      ],
      summary: 'All four dimensions passed.',
    };

    setImmediate(() => emitClaudeText(stdout, proc, JSON.stringify(claudePayload)));

    const result = await resultPromise;

    expect(result.verdict).toBe('approved');
    expect(result.dimensions).toHaveLength(4);
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledOnce();
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      expect.any(String),
    );
  });
});

// ── runClaude() — invalid JSON ────────────────────────────────────────────────

describe('PRReviewService.runClaude() — invalid JSON output', () => {
  it('stores a parse-error result (does not throw) when Claude output is not valid JSON', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    const { proc, stdout } = createMockProc();
    vi.mocked(spawn).mockReturnValue(proc as any);

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion());
    const resultPromise = service.reviewPR(42, 'owner/repo');

    setImmediate(() => emitClaudeText(stdout, proc, 'this is definitely not JSON'));

    const result = await resultPromise;

    expect(result.verdict).toBe('incomplete');
    expect(result.summary).toContain('Failed to parse');
    // Must still persist — not throw
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledOnce();
  });
});

// ── runClaude() — timeout ─────────────────────────────────────────────────────

describe('PRReviewService.runClaude() — 120-second timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('kills the subprocess and returns a timeout result after 120 seconds', async () => {
    vi.useFakeTimers();
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    const { proc } = createMockProc();
    vi.mocked(spawn).mockReturnValue(proc as any);

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion());
    const resultPromise = service.reviewPR(42, 'owner/repo');

    // Drain all pending microtasks so the Promise chain inside reviewPR
    // progresses until spawn() is called and setTimeout is registered.
    // All mock functions return pre-resolved Promises, so a fixed number
    // of microtask cycles is sufficient.
    await flushMicrotasks();

    // Advance fake clock by 120 s to fire the timeout callback
    vi.advanceTimersByTime(120_000);

    const result = await resultPromise;

    expect(vi.mocked(proc.kill)).toHaveBeenCalledWith('SIGTERM');
    expect(result.verdict).toBe('incomplete');
    expect(result.summary).toContain('timed out');
  });
});

// ── ALLOWED_TOOLS export ──────────────────────────────────────────────────────

describe('ALLOWED_TOOLS constant', () => {
  it('is exported from config.ts as a non-empty array', () => {
    expect(Array.isArray(ALLOWED_TOOLS)).toBe(true);
    expect(ALLOWED_TOOLS.length).toBeGreaterThan(0);
  });
});
