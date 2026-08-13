import { describe, it, expect } from 'vitest';
import {
  resolveCompletingSignal,
  REGISTERED_TRIPLES,
  DESIGN_COMPLETING_REASONS,
} from '../completingSignalRegistry';
import type { DerivedSessionOutcome } from '../sessionStatusDeriver';

describe('completingSignalRegistry', () => {
  it('resolves exactly one descriptor for every (session_type, task_type, hasOpenPR) triple in current use', () => {
    expect(REGISTERED_TRIPLES.length).toBeGreaterThan(0);
    for (const {
      sessionType,
      taskTypeCategory,
      hasOpenPR,
    } of REGISTERED_TRIPLES) {
      const descriptor = resolveCompletingSignal(
        sessionType,
        taskTypeCategory,
        hasOpenPR,
      );
      expect(descriptor).toBeDefined();
      expect(['staged_intent_terminal', 'external_pr_event']).toContain(
        descriptor.kind,
      );
      expect(Object.keys(descriptor.reasons).length).toBeGreaterThan(0);
    }
  });

  it('throws rather than silently defaulting for an unmapped triple', () => {
    // A standard (code) session with no PR yet has nothing for this
    // registry to interpret.
    expect(() => resolveCompletingSignal('standard', 'code', false)).toThrow(
      /no completing-signal descriptor mapped/,
    );
    // 'depth_review' sessions never produce a completing signal for this
    // registry — no PR is ever linked to one (see DepthReviewService.ts).
    expect(() =>
      resolveCompletingSignal('depth_review', 'any', false),
    ).toThrow(/no completing-signal descriptor mapped/);
  });

  it('resolves review sessions to the same external-PR-event descriptor as standard, despite never opening a PR of their own', () => {
    const descriptor = resolveCompletingSignal('review', 'any', false);
    expect(descriptor.kind).toBe('external_pr_event');
    expect(descriptor.reasons.pr_merged).toBe('done');
    expect(descriptor.reasons.pr_closed_without_merge).toBe('error');
  });

  it('every descriptor reason maps to a terminal DerivedSessionOutcome (no retrying, no non-terminal values)', () => {
    const validOutcomes: readonly DerivedSessionOutcome[] = [
      'done',
      'error',
      'killed',
      'superseded',
    ];
    for (const {
      sessionType,
      taskTypeCategory,
      hasOpenPR,
    } of REGISTERED_TRIPLES) {
      const descriptor = resolveCompletingSignal(
        sessionType,
        taskTypeCategory,
        hasOpenPR,
      );
      for (const outcome of Object.values(descriptor.reasons)) {
        expect(outcome).not.toBe('retrying');
        expect(validOutcomes).toContain(outcome);
      }
    }
  });

  it('external_pr_event descriptors distinguish merge from close-without-merge', () => {
    const descriptor = resolveCompletingSignal('standard', 'code', true);
    expect(descriptor.reasons.pr_merged).toBe('done');
    expect(descriptor.reasons.pr_closed_without_merge).toBe('error');
  });

  it('staged_intent_terminal descriptors use exactly the DESIGN_COMPLETING_REASONS vocabulary plus the operator-end reason', () => {
    const descriptor = resolveCompletingSignal(
      'design',
      'design_or_planning',
      false,
    );
    expect(descriptor.kind).toBe('staged_intent_terminal');
    for (const reason of DESIGN_COMPLETING_REASONS) {
      expect(descriptor.reasons[reason]).toBe('done');
    }
    expect(descriptor.reasons.planning_operator_end).toBe('done');
  });

  it('docs and ops fall back to staged-decision only when they have not opened a PR of their own', () => {
    const docsWithPr = resolveCompletingSignal('docs', 'docs_or_assets', true);
    const docsWithoutPr = resolveCompletingSignal(
      'docs',
      'docs_or_assets',
      false,
    );
    expect(docsWithPr.kind).toBe('external_pr_event');
    expect(docsWithoutPr.kind).toBe('staged_intent_terminal');

    const opsWithPr = resolveCompletingSignal('ops', 'ops_eligible', true);
    const opsWithoutPr = resolveCompletingSignal('ops', 'ops_eligible', false);
    expect(opsWithPr.kind).toBe('external_pr_event');
    expect(opsWithoutPr.kind).toBe('staged_intent_terminal');
  });
});
