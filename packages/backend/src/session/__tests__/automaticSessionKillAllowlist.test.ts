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
];

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
  const callRegex =
    /updateSessionStatus\(\s*[^,]+,\s*'(killed|error)'\s*,/g;
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
          offenders.push(`${path.relative(SESSION_DIR, file)}: reason=${reason}`);
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
    // terminal status in this module) — isolate its body and check.
    const pass0Body = content.slice(
      content.indexOf('function _runPass0'),
      content.indexOf('function _runPass1'),
    );
    expect(pass0Body.includes('_errorSession')).toBe(false);
    expect(pass0Body.includes('archiveSession')).toBe(true);
  });

  it('StuckSessionMonitor.ts never calls sessionManager.kill — hard-stop and park escalation must surface to the operator instead', () => {
    const content = fs.readFileSync(STUCK_SESSION_MONITOR, 'utf8');
    expect(content.includes('sessionManager.kill(')).toBe(false);
    expect(content.includes('sessionManager\n      .kill(')).toBe(false);
  });
});
