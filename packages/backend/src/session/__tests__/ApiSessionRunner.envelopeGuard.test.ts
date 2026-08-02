import { describe, it, expect, vi, beforeEach } from 'vitest';

// ApiSessionRunner has no directory-sandbox-equivalent mechanism (no
// getSessionAddDirs-style baseline+grant envelope like CliSessionRunner /
// DockerSessionRunner). Since session_mode: 'api' is a global runtime
// setting (see runtimeSettings.session_mode) rather than something gated
// per session type, nothing upstream stops a planning/ops session from
// being dispatched under it. Until API-mode parity is implemented, it must
// refuse to run a planning session type rather than silently running one
// unconfined to the envelope model the rest of the fleet assumes.
vi.mock('../../security/secrets', () => ({
  getSecret: vi.fn(() => 'fake-api-key'),
}));

import { ApiSessionRunner } from '../ApiSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

function makeOptions(sessionType?: string) {
  return {
    worktreePath: '/fake/worktree',
    model: undefined as string | undefined,
    allowedTools: ['Bash'],
    sessionType,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ApiSessionRunner planning-session envelope guard', () => {
  it.each(['groom', 'design', 'ops', 'docs', 'split'] as const)(
    'refuses to run a %s (planning) session — no filesystem-envelope parity implemented',
    async (sessionType) => {
      const runner = new ApiSessionRunner(SESSION_ID);
      await expect(
        runner.run('hello', undefined, makeOptions(sessionType), () => {}),
      ).rejects.toThrow(/does not implement the per-session-type/);
      expect(runner.hasSpawnError).toBe(true);
    },
  );

  it.each(['standard', 'review'] as const)(
    'does not raise the envelope guard for a %s (non-planning) session',
    async (sessionType) => {
      const runner = new ApiSessionRunner(SESSION_ID);
      // The real Agent SDK isn't stubbed here, so this run() call fails
      // downstream of the guard (no native binary in the test sandbox) —
      // the assertion is only that the *envelope guard* specifically never
      // fires for a non-planning session type.
      let caught: unknown;
      try {
        await runner.run(
          'hello',
          undefined,
          makeOptions(sessionType),
          () => {},
        );
      } catch (err) {
        caught = err;
      }
      expect(String(caught)).not.toMatch(
        /does not implement the per-session-type/,
      );
    },
  );
});
