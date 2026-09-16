/**
 * Regression test for flaky.confirm's gate=f2 masking guard against a real
 * git worktree (unlike verdictTools.test.ts, which mocks
 * session/autofix-runner's getChangedFiles entirely). Reproduces the
 * PR #1290 shape: the local worktree's `dev` branch pointer is stale
 * relative to `origin/dev`, so a file touched only by a commit that already
 * landed on origin/dev before the PR branched off must not be treated as
 * "in this session's diff" and must not mask an otherwise-eligible flaky
 * test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerVerdictTools } from './verdictTools';
import type { AgentSession } from '../../session/AgentSession';
import {
  getPRBySessionId,
  evaluateTestFlakinessCorpus,
} from '../../db/queries';
import {
  pauseReasonFromCanonical,
  serializePauseReason,
} from '../../db/pauseReason';

vi.mock('../../db/queries', () => ({
  getPRBySessionId: vi.fn(),
  evaluateTestFlakinessCorpus: vi.fn(),
  getLatestTestRequestRunForSession: vi.fn(),
  markTestResultExcused: vi.fn(),
}));

vi.mock('../../config', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('../../orchestration/baseAttributableFilter', () => ({
  firstRunCutoffMs: vi.fn(),
}));

vi.mock('../../config/settings', () => ({
  typedGetSetting: vi.fn(
    (key: string) =>
      ({
        flip_rate_window_n: 20,
        flip_rate_threshold_k: 2,
        flip_rate_breadth_n: 3,
        flip_rate_breadth_window_hours: 24,
      })[key],
  ),
}));

const execFileAsync = promisify(execFile);
const GIT_AUTHOR = ['-c', 'user.name=Test', '-c', 'user.email=test@test.com'];

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function setupStaleDevRepo(): Promise<{
  worktreeDir: string;
  cleanup: () => void;
}> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-masking-guard-'));
  const originDir = path.join(base, 'origin.git');
  const worktreeDir = path.join(base, 'worktree');

  fs.mkdirSync(originDir);
  await git(['init', '--bare', originDir], base);
  await git(['clone', originDir, worktreeDir], base);
  await git(['config', 'user.email', 'test@test.com'], worktreeDir);
  await git(['config', 'user.name', 'Test'], worktreeDir);

  // C1: initial commit on dev.
  fs.writeFileSync(path.join(worktreeDir, 'readme.txt'), 'hello\n');
  await git(['add', 'readme.txt'], worktreeDir);
  await git([...GIT_AUTHOR, 'commit', '-m', 'init'], worktreeDir);
  await git(['branch', '-M', 'dev'], worktreeDir);
  await git(['push', '-u', 'origin', 'dev'], worktreeDir);
  const staleDevSha = await git(['rev-parse', 'dev'], worktreeDir);

  // C2: a sibling PR lands on dev, touching a test file unrelated to this
  // PR (mirrors tests/ops/test_canary_verifier.py in PR #1290).
  fs.mkdirSync(path.join(worktreeDir, 'tests', 'ops'), { recursive: true });
  fs.writeFileSync(
    path.join(worktreeDir, 'tests', 'ops', 'test_canary_verifier.py'),
    'def test_x():\n    pass\n',
  );
  await git(['add', 'tests/ops/test_canary_verifier.py'], worktreeDir);
  await git(
    [...GIT_AUTHOR, 'commit', '-m', 'sibling PR adds canary verifier test'],
    worktreeDir,
  );
  await git(['push', 'origin', 'dev'], worktreeDir);

  // The PR branch is cut from the up-to-date dev (C2), then gets its own
  // commit. origin/dev is fetched and up to date at C2, but the local `dev`
  // ref is reset back to the stale C1 — simulating a long-lived worktree
  // that fetched but never fast-forwarded its local branch.
  await git(['checkout', '-b', 'feature/pr-1290', 'dev'], worktreeDir);
  fs.writeFileSync(path.join(worktreeDir, 'feature_file.txt'), 'new\n');
  await git(['add', 'feature_file.txt'], worktreeDir);
  await git([...GIT_AUTHOR, 'commit', '-m', 'PR commit'], worktreeDir);
  await git(['branch', '-f', 'dev', staleDevSha], worktreeDir);

  return {
    worktreeDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

function fakeSession(worktreePath: string) {
  return {
    worktreePath,
    recordReviewDisposition: vi.fn(),
    recordReviewVerdict: vi.fn(),
    recordVerifiedFlakyDisposition: vi.fn(),
    recordGateVerifyDisposition: vi.fn(),
    recordDeployAgenticVerdict: vi.fn(),
  } as unknown as AgentSession & {
    recordVerifiedFlakyDisposition: ReturnType<typeof vi.fn>;
  };
}

async function connectedClient(getSession: () => AgentSession | undefined) {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerVerdictTools(server, {
    sessionId: 'session-1',
    getSession,
    workflow: null,
  });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function resultOf(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content[0]?.text;
  if (typeof text !== 'string') throw new Error('expected text content');
  return JSON.parse(text) as Record<string, unknown>;
}

const CI_FAILING_PAUSE = serializePauseReason(
  pauseReasonFromCanonical('ci_failing'),
);

describe('flaky.confirm gate=f2 masking guard against a real worktree', () => {
  beforeEach(() => {
    vi.mocked(evaluateTestFlakinessCorpus).mockReturnValue({
      testId: 'tests.ops.test_canary_verifier.TestCanary.test_x',
      eligible: true,
    });
  });

  it('does not refuse a test whose only touching file predates the PR on a stale local dev ref', async () => {
    const { worktreeDir, cleanup } = await setupStaleDevRepo();
    try {
      vi.mocked(getPRBySessionId).mockReturnValue({
        pr_number: 1290,
        repo: 'owner/repo',
        created_at: '2026-08-01T00:00:00.000Z',
        base_branch: 'dev',
        pause_reason: CI_FAILING_PAUSE,
      } as never);

      const session = fakeSession(worktreeDir);
      const { client, close } = await connectedClient(() => session);
      const result = await client.callTool({
        name: 'flaky.confirm',
        arguments: {
          gate: 'f2',
          reason: 'fails across many trees, unrelated to my diff',
          testId: 'tests.ops.test_canary_verifier.TestCanary.test_x',
          testName: 'test_x',
        },
      });

      expect(resultOf(result as never)).toEqual({ status: 'ok' });
      expect(session.recordVerifiedFlakyDisposition).toHaveBeenCalledWith({
        gate: 'f2',
        reason: 'fails across many trees, unrelated to my diff',
      });
      await close();
    } finally {
      cleanup();
    }
  }, 15000);
});
