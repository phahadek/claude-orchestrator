/**
 * The single session-status deriver. Post-migration (see the sibling
 * dual-write/cutover task), this will be the sole writer of sessions.status
 * and sessions.terminal_completion_reason; today nothing calls it — it is
 * implemented and tested here against synthetic completing_signal_ledger
 * entries only.
 *
 * deriveSessionStatus is a pure function: given a session's identity, its
 * (session_type, task_type, hasOpenPR) triple, its completing-signal ledger
 * rows, and a caller-computed lineage fact, it returns the one terminal
 * outcome that applies, or null if the session is not yet terminal. It never
 * reads the database itself and performs no I/O — callers own gathering its
 * inputs and (post-migration) persisting its output.
 *
 * Output is deliberately narrower than SessionStatus: this deriver only ever
 * produces terminal outcomes (done/error/killed/superseded). 'retrying' is
 * not a member of DerivedSessionOutcome and never will be — see
 * ws/types.ts's ServerMessage.session_status union, which keeps 'retrying'
 * as a broadcast-only UI hint fired during an in-place transient-API-error
 * backoff window while the persisted sessions.status stays whatever it
 * already was. That vocabulary is unrelated to this deriver's contract.
 *
 * ── Concurrency / idempotency guarantee ─────────────────────────────────
 *
 * deriveSessionStatus itself is trivially idempotent: it is a pure function
 * over its arguments with no shared mutable state, so calling it twice with
 * the same inputs (the same ledger snapshot and lineage fact) returns the
 * same result, and calling it with a longer ledger (more rows appended since
 * the last call) can only ever move the outcome from null to a terminal
 * value or leave it unchanged — a completing-signal ledger row is
 * append-only and this deriver only ever consults the latest row per
 * signal_class, so a later call never "loses" a signal an earlier call saw.
 *
 * The guarantee that matters for the migration task is the *write* that
 * will pair with it: db/db.ts opens a single better-sqlite3 handle in one
 * Node.js process, and every better-sqlite3 statement executes
 * synchronously on the JS main thread (no worker_threads, no async
 * SQLite driver in this codebase) — so "compute the derived outcome, then
 * write completing_signal_ledger + sessions.status/terminal_completion_reason"
 * done as consecutive synchronous statements (no `await` between the read
 * and the write) cannot be interleaved by a concurrent request on the same
 * process; Node's single-threaded event loop guarantees no other JS runs
 * between them. The remaining hazard is a *pair of independent completing
 * signals racing to fire for the same session across two separate async
 * call sites (each with its own await before reaching the derive+write
 * step) — e.g. a PR merge webhook and a staged-intent apply landing back to
 * back. The migration task's call sites must serialize each session's
 * derive-and-write behind the same per-session guard the existing terminal
 * writers already use (updateSessionStatus's current-row read-before-write,
 * markSessionDone's in-flight-running guard) so the second signal to arrive
 * observes the first signal's ledger row (and the now-terminal sessions.status
 * it produced) rather than a stale snapshot — this deriver's job ends at
 * "given a consistent snapshot, produce a deterministic result"; making the
 * snapshot consistent under concurrent writers is the call site's guard, not
 * this function's.
 *
 * ── Race-safety guards the migration task must preserve ─────────────────
 *
 * The deriver's contract does not, by itself, replace three existing guards
 * that live in db/queries.ts and must keep protecting real writes once real
 * call sites are wired through this deriver:
 *
 *  1. markSessionDone's in-flight-running guard + pending_done_* deferral: a
 *     'done' write observed while the row is still 'running' must defer
 *     onto pending_done_* rather than stomp an in-flight turn (or be
 *     silently reverted by that turn's own terminal write once it
 *     finishes). A deriver-driven 'done' write is a markSessionDone call
 *     like any other and must go through this same deferral path.
 *  2. markSessionIdle's terminal-status guard: a clean-exit write must not
 *     revert an already-terminal row (e.g. one this deriver already marked
 *     done from a PR-merge signal) back to 'idle'.
 *  3. updateSessionStatus's reopen-terminal guard (the audited
 *     allowReopenTerminal path used by respawnSession/sendOrResume): a
 *     terminal row may only be reopened to a non-terminal status through
 *     that explicit, audited path — never as a side effect of a stale
 *     write racing behind it.
 *
 * This task documents the contract rather than enforcing it in code: no
 * real call site invokes deriveSessionStatus yet, so there is nothing here
 * for these guards to protect. Preserving them in the real call sites is
 * the migration task's acceptance criterion, not this one's.
 */

import type { CompletingSignalLedgerRow } from '../db/types';
import type { SessionType } from './sessionPredicates';
import type { TaskTypeCategory } from './completingSignalRegistry';
import { resolveCompletingSignal } from './completingSignalRegistry';

/**
 * The deriver's output vocabulary — strictly terminal, strictly excludes
 * 'retrying'. 'superseded' is a first-class typed member here, replacing
 * markSessionSuperseded's current special-cased, non-enum-typed raw string
 * write (sessions.status's SessionStatus type in db/types.ts does not
 * include 'superseded' today; the deriver is the first place it becomes a
 * properly typed outcome).
 */
export type DerivedSessionOutcome = 'done' | 'error' | 'killed' | 'superseded';

export interface DerivedSessionStatus {
  status: DerivedSessionOutcome;
  /**
   * The completing-signal descriptor's reason string, persisted as-is —
   * never null for a terminal outcome. Populated for every session type
   * (not just planning sessions, as today), per this task's scope. The
   * fixed 'superseded_by_newer_session' reason is used for the
   * lineage-derived outcome, which has no ledger-backed reason of its own.
   */
  terminalCompletionReason: string;
}

/** Fixed reason persisted for the lineage-derived superseded outcome — see deriveSessionStatus. */
export const SUPERSEDED_BY_NEWER_SESSION_REASON = 'superseded_by_newer_session';

export interface SessionStatusDeriverInput {
  sessionId: string;
  sessionType: SessionType;
  taskTypeCategory: TaskTypeCategory;
  /** Whether this session has ever opened its own PR — selects the registry's PR-outcome vs staged-decision descriptor for this triple. */
  hasOpenPR: boolean;
  /**
   * True iff a newer session exists for this session's task, past its
   * 'starting' status — the lineage rule that produces 'superseded',
   * independent of the completing-signal registry. Computed by the caller
   * (a lineage query is not this deriver's concern); see
   * db/queries.ts-shaped "other running sessions for task" queries for the
   * real signal this will be wired to.
   */
  hasNewerSessionForTask: boolean;
  /** This session's completing_signal_ledger rows, any order — the deriver only ever consults the most recent row per signal_class. */
  ledgerEntries: readonly CompletingSignalLedgerRow[];
}

/** The most recent ledger row (by recorded_at, then id, as tiebreaker) whose signal_class matches, or undefined if none. */
function latestMatchingSignal(
  entries: readonly CompletingSignalLedgerRow[],
  signalClass: CompletingSignalLedgerRow['signal_class'],
): CompletingSignalLedgerRow | undefined {
  let latest: CompletingSignalLedgerRow | undefined;
  for (const entry of entries) {
    if (entry.signal_class !== signalClass) continue;
    if (
      !latest ||
      entry.recorded_at > latest.recorded_at ||
      (entry.recorded_at === latest.recorded_at && entry.id > latest.id)
    ) {
      latest = entry;
    }
  }
  return latest;
}

/**
 * Derive the terminal outcome for a session, or null if it is not yet
 * terminal (no lineage-supersede fact and no recognized completing signal
 * in its ledger yet).
 *
 * Precedence: the lineage-derived superseded rule is checked first and
 * wins outright — a session superseded by a newer one for the same task is
 * superseded regardless of what its own ledger says, mirroring
 * markSessionSuperseded's existing use (retiring a stale row on a
 * same-lineage resume) which today runs independently of any
 * completing-signal interpretation.
 *
 * A 'resume_exhausted' ledger entry is checked next, ahead of the registry
 * lookup, and also wins outright. Unlike 'staged_intent'/'external_pr_event'
 * rows, it is not a task-type-specific completing decision — it is a
 * session-level circuit breaker (SessionManager.flagResumeFailure, tripped
 * once a session's poke/resume retry budget is exhausted) that applies to
 * every session type, including ones (review, depth_review, a pre-PR
 * 'standard' session) the registry has no descriptor for. Resolving it here
 * avoids resolveCompletingSignal throwing for those triples.
 */
export function deriveSessionStatus(
  input: SessionStatusDeriverInput,
): DerivedSessionStatus | null {
  if (input.hasNewerSessionForTask) {
    return {
      status: 'superseded',
      terminalCompletionReason: SUPERSEDED_BY_NEWER_SESSION_REASON,
    };
  }

  const resumeExhaustedEntry = latestMatchingSignal(
    input.ledgerEntries,
    'resume_exhausted',
  );
  if (resumeExhaustedEntry) {
    return {
      status: 'error',
      terminalCompletionReason: resumeExhaustedEntry.signal_value,
    };
  }

  const descriptor = resolveCompletingSignal(
    input.sessionType,
    input.taskTypeCategory,
    input.hasOpenPR,
  );

  const signalClass =
    descriptor.kind === 'staged_intent_terminal'
      ? 'staged_intent'
      : 'external_pr_event';
  const entry = latestMatchingSignal(input.ledgerEntries, signalClass);
  if (!entry) return null;

  const status = descriptor.reasons[entry.signal_value];
  if (!status) {
    throw new Error(
      `[sessionStatusDeriver] completing_signal_ledger row for session ` +
        `${input.sessionId} carries signal_value "${entry.signal_value}" ` +
        `which is not a recognized reason for its (session_type=${input.sessionType}, ` +
        `task_type=${input.taskTypeCategory}, hasOpenPR=${input.hasOpenPR}) descriptor ` +
        `— fail loudly rather than silently ignore the signal.`,
    );
  }

  return { status, terminalCompletionReason: entry.signal_value };
}
