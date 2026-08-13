import { describe, it, expect } from 'vitest';
import {
  deriveSessionStatus,
  SUPERSEDED_BY_NEWER_SESSION_REASON,
  type DerivedSessionOutcome,
  type SessionStatusDeriverInput,
} from '../sessionStatusDeriver';
import {
  DESIGN_COMPLETING_REASONS,
  PLANNING_OPERATOR_END_REASON,
} from '../completingSignalRegistry';
import type { CompletingSignalLedgerRow } from '../../db/types';

function ledgerRow(
  overrides: Partial<CompletingSignalLedgerRow> = {},
): CompletingSignalLedgerRow {
  return {
    id: 1,
    session_id: 'session-1',
    task_id: 'task-1',
    session_type: 'design',
    signal_class: 'staged_intent',
    signal_value: 'planning_approved',
    recorded_at: 1000,
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<SessionStatusDeriverInput> = {},
): SessionStatusDeriverInput {
  return {
    sessionId: 'session-1',
    sessionType: 'design',
    taskTypeCategory: 'design_or_planning',
    hasOpenPR: false,
    hasNewerSessionForTask: false,
    ledgerEntries: [],
    ...overrides,
  };
}

describe('deriveSessionStatus', () => {
  it('returns null when the session is not yet terminal (no lineage supersede, no ledger entry)', () => {
    expect(deriveSessionStatus(baseInput())).toBeNull();
  });

  describe('superseded-lineage rule', () => {
    it('wins outright when a newer session exists for the task, regardless of the ledger', () => {
      const result = deriveSessionStatus(
        baseInput({
          hasNewerSessionForTask: true,
          ledgerEntries: [ledgerRow({ signal_value: 'planning_approved' })],
        }),
      );
      expect(result).toEqual({
        status: 'superseded',
        terminalCompletionReason: SUPERSEDED_BY_NEWER_SESSION_REASON,
      });
    });

    it('does not fire when no newer session exists', () => {
      const result = deriveSessionStatus(
        baseInput({ hasNewerSessionForTask: false }),
      );
      expect(result).toBeNull();
    });
  });

  describe('staged-decision completion (design/groom/split/docs/ops without a PR)', () => {
    it('derives done from a planning_approved ledger entry', () => {
      const result = deriveSessionStatus(
        baseInput({
          ledgerEntries: [ledgerRow({ signal_value: 'planning_approved' })],
        }),
      );
      expect(result).toEqual({
        status: 'done',
        terminalCompletionReason: 'planning_approved',
      });
    });

    it('derives done from a planning_no_pending_dispositions ledger entry', () => {
      const result = deriveSessionStatus(
        baseInput({
          ledgerEntries: [
            ledgerRow({ signal_value: 'planning_no_pending_dispositions' }),
          ],
        }),
      );
      expect(result?.status).toBe('done');
    });

    it('uses the most recent matching ledger entry when several exist', () => {
      const result = deriveSessionStatus(
        baseInput({
          ledgerEntries: [
            ledgerRow({
              id: 1,
              signal_value: PLANNING_OPERATOR_END_REASON,
              recorded_at: 1000,
            }),
            ledgerRow({
              id: 2,
              signal_value: 'planning_approved',
              recorded_at: 2000,
            }),
          ],
        }),
      );
      expect(result?.terminalCompletionReason).toBe('planning_approved');
    });

    it('throws when the ledger carries a signal_value the registry does not recognize for this triple', () => {
      expect(() =>
        deriveSessionStatus(
          baseInput({
            ledgerEntries: [ledgerRow({ signal_value: 'not_a_real_reason' })],
          }),
        ),
      ).toThrow(/not a recognized reason/);
    });
  });

  describe('external PR-event completion (standard, and docs/ops that opened their own PR)', () => {
    it('derives done from pr_merged', () => {
      const result = deriveSessionStatus(
        baseInput({
          sessionType: 'standard',
          taskTypeCategory: 'code',
          hasOpenPR: true,
          ledgerEntries: [
            ledgerRow({
              session_type: 'standard',
              signal_class: 'external_pr_event',
              signal_value: 'pr_merged',
            }),
          ],
        }),
      );
      expect(result).toEqual({
        status: 'done',
        terminalCompletionReason: 'pr_merged',
      });
    });

    it('derives error from pr_closed_without_merge', () => {
      const result = deriveSessionStatus(
        baseInput({
          sessionType: 'docs',
          taskTypeCategory: 'docs_or_assets',
          hasOpenPR: true,
          ledgerEntries: [
            ledgerRow({
              session_type: 'docs',
              signal_class: 'external_pr_event',
              signal_value: 'pr_closed_without_merge',
            }),
          ],
        }),
      );
      expect(result).toEqual({
        status: 'error',
        terminalCompletionReason: 'pr_closed_without_merge',
      });
    });

    it('derives done from pr_merged for a review session, even though it never opened a PR of its own', () => {
      const result = deriveSessionStatus(
        baseInput({
          sessionType: 'review',
          taskTypeCategory: 'any',
          hasOpenPR: false,
          ledgerEntries: [
            ledgerRow({
              session_type: 'review',
              signal_class: 'external_pr_event',
              signal_value: 'pr_merged',
            }),
          ],
        }),
      );
      expect(result).toEqual({
        status: 'done',
        terminalCompletionReason: 'pr_merged',
      });
    });

    it('a staged_intent ledger row is ignored for a triple that expects external_pr_event', () => {
      const result = deriveSessionStatus(
        baseInput({
          sessionType: 'ops',
          taskTypeCategory: 'ops_eligible',
          hasOpenPR: true,
          ledgerEntries: [
            ledgerRow({
              session_type: 'ops',
              signal_class: 'staged_intent',
              signal_value: 'planning_approved',
            }),
          ],
        }),
      );
      expect(result).toBeNull();
    });
  });

  describe('terminal_completion_reason — consumer semantics', () => {
    // Mirrors PlanningOrchestrator.closeDeferredOpsTask's real check:
    //   !session.terminal_completion_reason ||
    //   !DESIGN_COMPLETING_REASONS.has(session.terminal_completion_reason)
    it('produces a reason that satisfies DESIGN_COMPLETING_REASONS.has(...) for a natural design completion', () => {
      const result = deriveSessionStatus(
        baseInput({
          ledgerEntries: [ledgerRow({ signal_value: 'planning_approved' })],
        }),
      );
      expect(result).not.toBeNull();
      expect(
        DESIGN_COMPLETING_REASONS.has(result!.terminalCompletionReason),
      ).toBe(true);
    });

    it('produces a reason that does NOT satisfy DESIGN_COMPLETING_REASONS.has(...) for an operator-ended session', () => {
      const result = deriveSessionStatus(
        baseInput({
          ledgerEntries: [
            ledgerRow({ signal_value: PLANNING_OPERATOR_END_REASON }),
          ],
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe('done');
      expect(
        DESIGN_COMPLETING_REASONS.has(result!.terminalCompletionReason),
      ).toBe(false);
    });

    // Mirrors AgentSession.endSession's real check: !!row?.terminal_completion_reason
    it('always yields a truthy terminalCompletionReason for a terminal outcome', () => {
      const outcomes: Array<SessionStatusDeriverInput> = [
        baseInput({
          ledgerEntries: [ledgerRow({ signal_value: 'planning_approved' })],
        }),
        baseInput({ hasNewerSessionForTask: true }),
        baseInput({
          sessionType: 'standard',
          taskTypeCategory: 'code',
          hasOpenPR: true,
          ledgerEntries: [
            ledgerRow({
              session_type: 'standard',
              signal_class: 'external_pr_event',
              signal_value: 'pr_merged',
            }),
          ],
        }),
      ];
      for (const input of outcomes) {
        const result = deriveSessionStatus(input);
        expect(result).not.toBeNull();
        expect(!!result!.terminalCompletionReason).toBe(true);
      }
    });

    it('yields null (no reason at all — falsy, matching a fresh row) when the session is not yet terminal', () => {
      const result = deriveSessionStatus(baseInput());
      expect(result).toBeNull();
    });
  });

  describe('resume_exhausted circuit breaker', () => {
    it('derives error from a resume_exhausted ledger entry, independent of the registry triple', () => {
      const result = deriveSessionStatus(
        baseInput({
          // 'depth_review' has no registered descriptor at all — resolving
          // it via the registry would throw. resume_exhausted must
          // short-circuit before that lookup.
          sessionType: 'depth_review',
          taskTypeCategory: 'any',
          hasOpenPR: false,
          ledgerEntries: [
            ledgerRow({
              session_type: 'depth_review',
              signal_class: 'resume_exhausted',
              signal_value: 'resume_failed',
            }),
          ],
        }),
      );
      expect(result).toEqual({
        status: 'error',
        terminalCompletionReason: 'resume_failed',
      });
    });

    it('loses to the superseded-lineage rule', () => {
      const result = deriveSessionStatus(
        baseInput({
          hasNewerSessionForTask: true,
          ledgerEntries: [
            ledgerRow({
              signal_class: 'resume_exhausted',
              signal_value: 'resume_failed',
            }),
          ],
        }),
      );
      expect(result).toEqual({
        status: 'superseded',
        terminalCompletionReason: SUPERSEDED_BY_NEWER_SESSION_REASON,
      });
    });

    it('wins over a registry-mapped triple when both signal classes are present, since it is checked first', () => {
      const result = deriveSessionStatus(
        baseInput({
          ledgerEntries: [
            ledgerRow({ signal_value: 'planning_approved', recorded_at: 500 }),
            ledgerRow({
              signal_class: 'resume_exhausted',
              signal_value: 'resume_failed',
              recorded_at: 2000,
            }),
          ],
        }),
      );
      expect(result).toEqual({
        status: 'error',
        terminalCompletionReason: 'resume_failed',
      });
    });
  });

  it('the output type has no "retrying" member', () => {
    const impossible: DerivedSessionOutcome[] = [
      'done',
      'error',
      'killed',
      'superseded',
    ];
    // @ts-expect-error — 'retrying' must not be assignable to DerivedSessionOutcome.
    const notAllowed: DerivedSessionOutcome = 'retrying';
    expect(impossible).not.toContain(
      notAllowed as unknown as DerivedSessionOutcome,
    );
  });
});
