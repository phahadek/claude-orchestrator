/**
 * Guard test for the operator ruling (2026-08-28): automatic session
 * killing is removed — a machine path may never write a terminal
 * ('killed'/'error') session status by inferring abandonment from process
 * absence, elapsed time, or status alone. Terminalizing a session is an
 * operator action.
 *
 * Scans the session modules (plus StuckSessionMonitor, the one
 * orchestration/ module the governing task named explicitly) for a literal
 * terminal-status write — updateSessionStatus(..., 'killed'|'error', ...)
 * or markSessionErrored(..., 'killed'|'error', <reason>, ...) — and checks
 * the accompanying reason string against an explicit allow-list. A reason
 * not on the list fails the test, so a new automatic kill path can't be
 * added silently.
 *
 * The allow-list has two kinds of entries, both commented at their
 * call site:
 *   - operator-initiated (user_kill, operator_abort): the only writes this
 *     ruling permits going forward.
 *   - evidence-based, not an inference (run_error, launch_failed/
 *     backend_spawn_degraded, runner_non_zero, context_overflow): the
 *     session's own process reported a real crash/exception/exit code, or a
 *     definitive external fact (e.g. a resolved PR) confirmed the outcome —
 *     never a guess from the session merely going quiet. Out of scope for
 *     this task, which targets machine paths that terminalized a session
 *     because its OS process (or a timer, or a status) merely looked dead.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SESSION_DIR = path.join(__dirname, '..');
const STUCK_SESSION_MONITOR = path.join(
  __dirname,
  '../../orchestration/StuckSessionMonitor.ts',
);

interface AllowedWrite {
  file: string;
  reason: string;
  kind: 'operator' | 'evidence-based';
}

const ALLOWED_TERMINAL_WRITES: AllowedWrite[] = [
  { file: 'AgentSession.ts', reason: 'user_kill', kind: 'operator' },
  { file: 'SessionManager.ts', reason: 'operator_abort', kind: 'operator' },
  {
    file: 'SessionManager.ts',
    reason: 'run_error',
    kind: 'evidence-based',
  },
  {
    file: 'SessionManager.ts',
    // pauseReason var — covers 'launch_failed' and the backend-spawn-degraded
    // reason, both raised only from a genuine spawn exception/rejection.
    reason: 'pauseReason',
    kind: 'evidence-based',
  },
  {
    file: 'AgentSession.ts',
    reason: 'context_overflow',
    kind: 'evidence-based',
  },
  {
    file: 'AgentSession.ts',
    // variable — resolves to 'runner_non_zero', set only for a real,
    // non-null, non-zero process exit code (never a killed/timed-out null).
    reason: 'reason',
    kind: 'evidence-based',
  },
  {
    file: 'AgentSession.ts',
    // AgentSession.kill()'s own markSessionErrored call forwards whatever
    // reason its caller passed in opts.reason — it never hardcodes
    // 'user_kill' (or any other reason) itself. The real authorization
    // check for who may reach a 'user_kill' write lives in the
    // findUserKillCallSites check below, which inspects the `.kill(...)`
    // call sites directly instead of this forwarded variable.
    reason: 'opts.reason',
    kind: 'operator',
  },
];

/**
 * Allow-list for `.kill(...)` call sites that pass a literal
 * reason: 'user_kill' — the one reason string that both (a) is exempt from
 * the task_crash_counts budget (SessionManager's UNCOUNTED_REASONS) and (b)
 * suppresses planning re-dispatch (db/queries.ts's isPlanningKillSuppressed).
 * Because AgentSession.kill() now forwards whatever reason its caller
 * supplies (see the 'opts.reason' allow-list entry above), a machine path
 * could silently start claiming this operator-only label by passing the
 * literal itself — this check catches that at the actual call site instead.
 * Each entry is anchored by a substring that must appear within
 * USER_KILL_CONTEXT_WINDOW characters before the match, not just the file,
 * so a second call site added later in the same file is not implicitly
 * covered.
 */
interface AllowedUserKillCallSite {
  file: string;
  contextContains: string;
}

const ALLOWED_USER_KILL_CALL_SITES: AllowedUserKillCallSite[] = [
  {
    file: 'SessionManager.ts',
    // The operator kill route (SessionManager.kill(sessionId)) — the only
    // sanctioned writer of reason 'user_kill'.
    contextContains: 'async kill(sessionId: string): Promise<void> {',
  },
];

const USER_KILL_CONTEXT_WINDOW = 400;

/**
 * Finds every `.kill({ ... reason: 'user_kill' ... })` call site and
 * returns the string index of each match, so the caller can inspect the
 * surrounding context to decide whether it's an allow-listed call site.
 * Exported implicitly via the describe block below — kept local since only
 * this file's tests need it.
 */
function findUserKillCallSites(content: string): number[] {
  const regex = /\.kill\(\s*\{[^}]*reason:\s*'user_kill'/g;
  const indices: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    indices.push(match.index);
  }
  return indices;
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Finds every markSessionErrored(...) call whose 2nd argument is the
 * literal 'killed' or 'error', and returns the 3rd argument (the reason)
 * verbatim — a variable name or a string literal's contents.
 */
function findMarkSessionErroredReasons(content: string): string[] {
  const reasons: string[] = [];
  // The status arg is either a 'killed'/'error' literal, or the bare
  // identifier `status` for the one call site (AgentSession's non-zero-exit
  // classification) that resolves it from a locally-scoped const — see the
  // 'reason' allow-list entry below, which covers that same call by name.
  const callRegex =
    /markSessionErrored\??\.?\(\s*[^,]+,\s*(?:'(?:killed|error)'|status)\s*,\s*([^,)]+)/g;
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(content))) {
    const rawReason = match[1].trim();
    const stringLiteral = rawReason.match(/^'([^']*)'$/);
    reasons.push(stringLiteral ? stringLiteral[1] : rawReason);
  }
  return reasons;
}

/**
 * Finds every updateSessionStatus(...) call whose 2nd argument is the
 * literal 'killed' or 'error' status — the direct-write fallback path used
 * when no SessionManager is available (or by the sanctioned operator
 * routes that bypass markSessionErrored entirely, e.g. abortSession).
 */
function findDirectStatusWrites(content: string): number {
  const callRegex = /updateSessionStatus\(\s*[^,]+,\s*'(killed|error)'\s*,/g;
  return [...content.matchAll(callRegex)].length;
}

describe('automatic session-kill allow-list guard', () => {
  it('every markSessionErrored(..., "killed"/"error", reason) call site in the session modules names a reason on the allow-list', () => {
    const files = [...walk(SESSION_DIR), STUCK_SESSION_MONITOR].filter(
      (f) => !f.includes('__tests__'),
    );
    const offenders: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const baseName = path.basename(file);
      const reasons = findMarkSessionErroredReasons(content);
      for (const reason of reasons) {
        const allowed = ALLOWED_TERMINAL_WRITES.some(
          (entry) => entry.file === baseName && entry.reason === reason,
        );
        if (!allowed) {
          offenders.push(
            `${path.relative(SESSION_DIR, file)}: reason=${reason}`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('sessionLivenessReconciler.ts contains no terminal-status write of any kind', () => {
    const content = fs.readFileSync(
      path.join(SESSION_DIR, 'sessionLivenessReconciler.ts'),
      'utf8',
    );
    expect(findDirectStatusWrites(content)).toBe(0);
    expect(content.includes('markSessionErrored')).toBe(false);
  });

  it('bootIdleReconciliation.ts Pass 0 (dead-at-boot) contains no terminal-status write — only Pass 1/2 (PR-anchored, definitive evidence) may write one', () => {
    const content = fs.readFileSync(
      path.join(SESSION_DIR, 'bootIdleReconciliation.ts'),
      'utf8',
    );
    // _runPass0 must not call _errorSession (the only helper that writes a
    // terminal status in this module) — isolate its body and check. It
    // drains the row out of occupancy via setSessionParkedAt instead of
    // archiveSession, since process absence alone must never archive (hide)
    // the row — see the parked_at occupancy marker in schema.ts.
    const pass0Body = content.slice(
      content.indexOf('function _runPass0'),
      content.indexOf('function _runPass1'),
    );
    expect(pass0Body.includes('_errorSession')).toBe(false);
    expect(pass0Body.includes('setSessionParkedAt')).toBe(true);
  });

  it('StuckSessionMonitor.ts never calls sessionManager.kill — hard-stop and park escalation must surface to the operator instead', () => {
    const content = fs.readFileSync(STUCK_SESSION_MONITOR, 'utf8');
    expect(content.includes('sessionManager.kill(')).toBe(false);
    expect(content.includes('sessionManager\n      .kill(')).toBe(false);
  });

  it('every `.kill(...)` call site passing reason: \'user_kill\' is on the operator allow-list', () => {
    const files = walk(SESSION_DIR).filter((f) => !f.includes('__tests__'));
    const offenders: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const baseName = path.basename(file);
      for (const idx of findUserKillCallSites(content)) {
        const context = content.slice(
          Math.max(0, idx - USER_KILL_CONTEXT_WINDOW),
          idx,
        );
        const allowed = ALLOWED_USER_KILL_CALL_SITES.some(
          (site) =>
            site.file === baseName && context.includes(site.contextContains),
        );
        if (!allowed) {
          offenders.push(`${path.relative(SESSION_DIR, file)}@${idx}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('flags a synthetic non-operator call site that reaches a user_kill write', () => {
    const synthetic = `
      async respawnForSomeMachinePath(sessionId: string) {
        const liveSession = this.sessions.get(sessionId);
        if (liveSession) {
          await liveSession.kill({ suppressReap: true, reason: 'user_kill' });
        }
      }
    `;

    const indices = findUserKillCallSites(synthetic);
    expect(indices.length).toBe(1);

    const context = synthetic.slice(
      Math.max(0, indices[0] - USER_KILL_CONTEXT_WINDOW),
      indices[0],
    );
    const allowed = ALLOWED_USER_KILL_CALL_SITES.some((site) =>
      context.includes(site.contextContains),
    );
    expect(allowed).toBe(false);
  });

  it('resumeSession\'s 30s no-events watchdog calls flagResumeFailure before kill(), and never passes it a reason — the terminal write must already have happened before kill()\'s alreadyConcluded guard is reached, not via a user_kill label', () => {
    const content = fs.readFileSync(
      path.join(SESSION_DIR, 'SessionManager.ts'),
      'utf8',
    );
    const marker = 'no events within 30s after resume';
    const markerIdx = content.indexOf(marker);
    expect(markerIdx).toBeGreaterThan(-1);

    // Scope to the setTimeout callback body around the marker — cheap
    // proxy for "this specific watchdog", not the whole file.
    const windowEnd = content.indexOf('}, RESUME_TIMEOUT_MS);', markerIdx);
    expect(windowEnd).toBeGreaterThan(-1);
    const body = content.slice(markerIdx, windowEnd);

    const flagIdx = body.indexOf('this.flagResumeFailure(');
    const killIdx = body.indexOf('session.kill(');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeGreaterThan(-1);
    // flagResumeFailure (which writes the terminal 'error' status) must run
    // first, so kill()'s alreadyConcluded guard is already true by the time
    // kill() reads the row — no markSessionErrored/user_kill write happens.
    expect(flagIdx).toBeLessThan(killIdx);

    // The kill() call here must never carry a reason — it relies entirely
    // on flagResumeFailure's prior write, not on a borrowed operator label.
    const killCallMatch = body.match(/session\.kill\(([^)]*)\)/);
    expect(killCallMatch).not.toBeNull();
    expect(killCallMatch![1].trim()).toBe('');
  });
});
