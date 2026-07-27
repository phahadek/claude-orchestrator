/**
 * Regression coverage for the session-prompts carve-out: a locked-down
 * checkout must never block the launcher's own per-session control-plane
 * writes (writeMcpConfig / writeSystemPromptFile), since those run on the
 * shared launch path for every session type — not just planning sessions.
 *
 * Unlike checkoutLockdown.test.ts (which only asserts on file modes against
 * a synthetic tree), this drives the real launcher write functions against
 * a real locked-down directory to prove the actual failure shape is fixed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

// SessionManager.ts pulls in a lot of unrelated subsystems at module scope.
// Stub those out; only writeMcpConfig/writeSystemPromptFile are exercised
// here, and they don't touch any of these.
vi.mock('../AgentSession', () => ({
  AgentSession: vi.fn(),
  parseNotionPageIdDashed: vi.fn().mockReturnValue(''),
}));
vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({})),
  reapOrphanContainers: vi.fn(),
}));
vi.mock('../ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockResolvedValue(''),
}));
vi.mock('../orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue(''),
}));
vi.mock('../branchModel', () => ({
  resolveStartingPoint: vi
    .fn()
    .mockReturnValue({ startingPoint: 'dev', milestoneSlug: null }),
  ensureMilestoneBranch: vi.fn(),
  deriveBranchSlug: vi.fn().mockReturnValue('feature/my-task'),
}));
vi.mock('../orchestrator-config', () => ({
  loadOrchestratorConfig: vi
    .fn()
    .mockReturnValue({ mcp_servers: undefined, allowed_tools: [] }),
  isGrantable: vi.fn().mockReturnValue(false),
  isToolShapedCapability: vi.fn().mockReturnValue(false),
}));
vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('running'),
}));
vi.mock('../../tasks/taskId', () => ({
  formatTaskId: vi.fn().mockReturnValue('task-123'),
}));
vi.mock('../../notion/NotionClient', () => ({ parseSection: vi.fn() }));
vi.mock('../../github/reviewUtils', () => ({
  formatReviewFeedback: vi.fn().mockReturnValue('review-feedback'),
  formatApprovedVerdictMessage: vi.fn().mockReturnValue('approved'),
}));
vi.mock('../../security/scrubSecrets', () => ({
  scrubSecrets: vi.fn().mockImplementation((s: string) => s),
}));
vi.mock('../../config/corporateMode', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ gates: { dockerMandatory: false } }),
}));
vi.mock('../../config', () => ({
  config: { maxConcurrentCodeSessions: 5 },
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: { session_mode: 'cli', corporate_mode_enabled: false },
}));

import {
  acquireCheckoutLockdown,
  releaseCheckoutLockdown,
} from '../checkoutLockdown';
import { writeMcpConfig, writeSystemPromptFile } from '../SessionManager';
import { _resetStageCredentialsForTesting } from '../../auth/SessionStageAuth';

function canWrite(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

describe('checkoutLockdown — session-prompts carve-out', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'checkout-lockdown-session-prompts-'),
    );
    fs.writeFileSync(path.join(projectDir, 'README.md'), 'hello\n');
    // In production, writeMcpConfig/writeSystemPromptFile always run (via
    // completeStart) before acquireCheckoutLockdown, so .claude/session-prompts
    // already exists by the time any lock is acquired. Mirror that call order.
    fs.mkdirSync(path.join(projectDir, '.claude', 'session-prompts'), {
      recursive: true,
    });
    _resetStageCredentialsForTesting();
  });

  afterEach(() => {
    fs.chmodSync(projectDir, 0o755);
    for (const entry of fs.readdirSync(projectDir)) {
      try {
        fs.chmodSync(path.join(projectDir, entry), 0o755);
      } catch {
        // best-effort
      }
    }
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('leaves .claude/session-prompts writable after stripWriteRecursive runs', async () => {
    await acquireCheckoutLockdown(projectDir, 'session-a', {
      applyFsLockdown: true,
    });

    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(false);
    expect(canWrite(path.join(projectDir, '.claude', 'session-prompts'))).toBe(
      true,
    );

    await releaseCheckoutLockdown('session-a', { applyFsLockdown: true });
  });

  it('writes the real MCP config and system prompt files against a locked checkout', async () => {
    await acquireCheckoutLockdown(projectDir, 'session-a', {
      applyFsLockdown: true,
    });

    const mcpConfigPath = writeMcpConfig(projectDir, 'session-a', undefined);
    const systemPromptPath = writeSystemPromptFile(
      projectDir,
      'session-a',
      'rules',
    );

    expect(mcpConfigPath).toBe(
      path.join(projectDir, '.claude', 'session-prompts', 'session-a.mcp.json'),
    );
    expect(fs.existsSync(mcpConfigPath)).toBe(true);
    expect(systemPromptPath).toBe(
      path.join(projectDir, '.claude', 'session-prompts', 'session-a.md'),
    );
    expect(fs.existsSync(systemPromptPath)).toBe(true);

    await releaseCheckoutLockdown('session-a', { applyFsLockdown: true });
  });

  it('a second concurrent session can write its own prompt files while the first still holds the lock', async () => {
    await acquireCheckoutLockdown(projectDir, 'session-a', {
      applyFsLockdown: true,
    });
    await acquireCheckoutLockdown(projectDir, 'session-b', {
      applyFsLockdown: true,
    });

    expect(() =>
      writeMcpConfig(projectDir, 'session-b', undefined),
    ).not.toThrow();
    expect(() =>
      writeSystemPromptFile(projectDir, 'session-b', 'rules'),
    ).not.toThrow();

    const mcpPath = path.join(
      projectDir,
      '.claude',
      'session-prompts',
      'session-b.mcp.json',
    );
    expect(fs.existsSync(mcpPath)).toBe(true);

    await releaseCheckoutLockdown('session-a', { applyFsLockdown: true });
    await releaseCheckoutLockdown('session-b', { applyFsLockdown: true });
  });

  it('restores owner-write on session-prompts left read-only by a pre-fix lock, on the last release', async () => {
    await acquireCheckoutLockdown(projectDir, 'session-a', {
      applyFsLockdown: true,
    });
    const sessionPromptsDir = path.join(
      projectDir,
      '.claude',
      'session-prompts',
    );
    // Simulate a lock acquired by pre-fix code, before session-prompts was
    // excluded from the strip walk.
    fs.chmodSync(sessionPromptsDir, 0o444);
    expect(canWrite(sessionPromptsDir)).toBe(false);

    await releaseCheckoutLockdown('session-a', { applyFsLockdown: true });

    expect(canWrite(sessionPromptsDir)).toBe(true);
  });
});
