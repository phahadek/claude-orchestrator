import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AuditLog before importing the watcher
vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../db/queries', () => ({
  setPauseReason: vi.fn(),
}));

import {
  checkCommitAttribution,
  AI_TRAILER_REGEX,
} from './CommitAttributionWatcher';
import { ORCHESTRATOR_BOT_EMAIL } from '../session/autofix-runner';
import { recordEvent } from '../audit/AuditLog';
import { setPauseReason } from '../db/queries';
import type { GitHubClient } from './GitHubClient';

function makeClient(
  commits: Array<{ sha: string; message: string; author?: { email?: string } }>,
): GitHubClient {
  return {
    getCommitsForPR: vi.fn().mockResolvedValue(commits),
  } as unknown as GitHubClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AI_TRAILER_REGEX', () => {
  it('matches a valid AI-Authored-By trailer', () => {
    expect(
      AI_TRAILER_REGEX.test(
        'feat: add thing\n\nAI-Authored-By: claude-sonnet-4-6 (session: abc)',
      ),
    ).toBe(true);
  });

  it('does not match commits without the trailer', () => {
    expect(
      AI_TRAILER_REGEX.test('feat: add thing\n\nCo-Authored-By: human'),
    ).toBe(false);
  });
});

describe('checkCommitAttribution()', () => {
  it('returns missing=0 when all commits have the trailer', async () => {
    const client = makeClient([
      {
        sha: 'aaa',
        message: 'feat: x\n\nAI-Authored-By: claude-sonnet-4-6 (session: s1)',
      },
    ]);
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      1,
      's1',
      null,
      null,
      false,
    );
    expect(result.checked).toBe(1);
    expect(result.missing).toBe(0);
    expect(result.paused).toBe(false);
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
  });

  it('records attribution_missing to the audit log when a trailer is absent', async () => {
    const client = makeClient([
      { sha: 'bbb', message: 'feat: no trailer here' },
    ]);
    await checkCommitAttribution(
      client,
      'owner/repo',
      2,
      'session-xyz',
      'proj-1',
      'task-1',
      false,
    );
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'attribution_missing',
        actor_type: 'ai',
        actor_id: 'session-xyz',
        payload: expect.objectContaining({
          sha: 'bbb',
          pr_number: 2,
          repo: 'owner/repo',
        }),
      }),
    );
    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
  });

  it('pauses in corporate mode when a trailer is absent', async () => {
    const client = makeClient([
      { sha: 'ccc', message: 'chore: no attribution' },
    ]);
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      3,
      's1',
      null,
      null,
      true,
    );
    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      3,
      'owner/repo',
      'attribution_missing',
    );
    expect(result.paused).toBe(true);
  });

  it('does NOT pause in non-corporate mode even when trailer is absent', async () => {
    const client = makeClient([{ sha: 'ddd', message: 'fix: oops' }]);
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      4,
      's1',
      null,
      null,
      false,
    );
    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
    expect(result.paused).toBe(false);
    expect(result.missing).toBe(1);
  });

  it('handles fetch errors gracefully', async () => {
    const client = {
      getCommitsForPR: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as GitHubClient;
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      5,
      's1',
      null,
      null,
      false,
    );
    expect(result.checked).toBe(0);
    expect(result.missing).toBe(0);
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
  });

  it('only records missing for commits without the trailer (mixed batch)', async () => {
    const client = makeClient([
      {
        sha: 'e1',
        message:
          'feat: good\n\nAI-Authored-By: claude-sonnet-4-6 (session: s1)',
      },
      { sha: 'e2', message: 'chore: bad — no trailer' },
    ]);
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      6,
      's1',
      null,
      null,
      false,
    );
    expect(result.checked).toBe(2);
    expect(result.missing).toBe(1);
    expect(vi.mocked(recordEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ sha: 'e2' }),
      }),
    );
  });

  it('does NOT record attribution_missing for bot-authored commit without trailer', async () => {
    const client = makeClient([
      {
        sha: 'f1',
        message: 'chore: apply autofix [orchestrator]',
        author: { email: ORCHESTRATOR_BOT_EMAIL },
      },
    ]);
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      7,
      's1',
      null,
      null,
      false,
    );
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
    expect(result.missing).toBe(0);
  });

  it('does NOT record attribution_missing for bot-authored commit even with trailer present', async () => {
    const client = makeClient([
      {
        sha: 'f2',
        message:
          'chore: apply autofix [orchestrator]\n\nAI-Authored-By: claude-sonnet-4-6 (session: s1)',
        author: { email: ORCHESTRATOR_BOT_EMAIL },
      },
    ]);
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      8,
      's1',
      null,
      null,
      false,
    );
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
    expect(result.missing).toBe(0);
  });

  it('still records attribution_missing for session commit without trailer (regression)', async () => {
    const client = makeClient([
      {
        sha: 'g1',
        message: 'feat: session commit no trailer',
        author: { email: 'session@example.com' },
      },
    ]);
    await checkCommitAttribution(
      client,
      'owner/repo',
      9,
      'session-abc',
      null,
      null,
      false,
    );
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'attribution_missing',
        payload: expect.objectContaining({ sha: 'g1' }),
      }),
    );
  });

  it('does NOT record attribution_missing for session commit with trailer (regression)', async () => {
    const client = makeClient([
      {
        sha: 'g2',
        message:
          'feat: session commit with trailer\n\nAI-Authored-By: claude-sonnet-4-6 (session: s1)',
        author: { email: 'session@example.com' },
      },
    ]);
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      10,
      's1',
      null,
      null,
      false,
    );
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
    expect(result.missing).toBe(0);
  });
});
