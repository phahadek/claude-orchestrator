/**
 * Approve-by-standard triage verdict taxonomy + deterministic floor — the
 * procedure-core piece that lets an interactive (not-auto-dispatched) task
 * type promote on a batched, consolidated verdict instead of a per-item
 * human decision. Auto-dispatched types (💻 Code) are unaffected: they keep
 * the per-task human gate unchanged (see procedures.md, Task types).
 *
 * Today the only interactive types are 📐 Design and 📋 Planning
 * (INTERACTIVE_TASK_TYPES) — locked by the Design task "Make /groom
 * Design-task promotion exception-based".
 *
 * The per-task server-enforced records (checkGroomingPromotionGate in
 * groomGate.ts: size_check, type_check, gate/seed contribution, FM1–FM3
 * constraint dispositions) stay required and type-agnostic — this module
 * only governs the human per-item decision that approve-by-standard removes
 * for interactive types.
 *
 * LOAD-BEARING: reduced ceremony is NOT reduced rigor. The 'clean' verdict
 * is earned by the groomer's arch-page reading + code exploration + anchor
 * grounding — the sole non-server backstop once the per-item decision is
 * removed. The deterministic floor below only ever DOWNGRADES a proposed
 * 'clean' verdict against hard, server-derivable facts; it never upgrades a
 * judgment call of 'blocked' or 'needs-attention' back to 'clean'.
 */

/**
 * clean: a genuine, decision-shaped, answerable-now, scoped open question.
 * blocked: answerable only after an upstream Design task locks.
 * needs-attention: no real questions / already-decided / not-answerable /
 * mis-shaped / missing heading.
 */
export type TriageVerdict = 'clean' | 'blocked' | 'needs-attention';

/** Task types eligible for approve-by-standard triage; 💻 Code stays per-task-gated. */
export const INTERACTIVE_TASK_TYPES: ReadonlySet<string> = new Set([
  '📐 Design',
  '📋 Planning',
]);

export function isInteractiveTaskType(type: string | undefined): boolean {
  return !!type && INTERACTIVE_TASK_TYPES.has(type);
}

function normalizeHeadingText(text: string): string {
  return text
    .replace(/[^\p{L}\s]/gu, '')
    .trim()
    .toLowerCase();
}

/** True when the body carries a live "## Open Questions" (or singular) heading, regardless of section contents. */
export function hasOpenQuestionsHeading(body: string): boolean {
  return body.split('\n').some((line) => {
    const m = line.match(/^#{1,6}\s*(.+)$/);
    if (!m) return false;
    const normalized = normalizeHeadingText(m[1]);
    return normalized === 'open questions' || normalized === 'open question';
  });
}

export interface TriageFloorInput {
  /** The groomer's judgment-primary verdict, before the deterministic floor. */
  proposedVerdict: TriageVerdict;
  /**
   * True when this task carries a non-Done hard-block dependency (an
   * upstream 📐 Design / 📋 Planning task in Depends On that hasn't reached
   * ✅ Done / ⏭️ Deferred) — its outcome may still reshape this task.
   */
  hardBlockDepNotDone: boolean;
  /** True when the task body has a live "## Open Questions" heading. */
  hasOpenQuestionsHeading: boolean;
  /**
   * True when a binding constraint on this task is dispositioned
   * conflict_route (see constraintCatalog.ts / groomGate.ts's FM1 guard) —
   * a routed constraint-conflict, re-derived server-side, never a
   * caller-asserted verdict.
   */
  hasRoutedConstraintConflict: boolean;
}

export interface TriageFloorResult {
  verdict: TriageVerdict;
  /** Non-empty only when the floor changed (downgraded) the proposed verdict. */
  reasons: string[];
}

/**
 * The deterministic floor. Judgment-primary: `proposedVerdict` is the
 * groomer's call, and the floor only ever moves it away from 'clean' when a
 * hard fact contradicts it — it never manufactures a 'clean' verdict and
 * never upgrades an already-judged 'blocked'/'needs-attention' call.
 *
 * Deliberately does NOT consult the Tier-2 deferral-phrase lexicon
 * (readinessGate.ts's DEFERRAL_PHRASES) — that lexicon is advisory-only for
 * Design: it false-positives on legitimate design deferrals ("decide during
 * implementation" reads as a deferral phrase but is a normal design-scoping
 * statement), and Tier 3 (semantic classification) already exempts Design.
 */
export function applyTriageFloor(input: TriageFloorInput): TriageFloorResult {
  if (input.hardBlockDepNotDone) {
    return {
      verdict: 'blocked',
      reasons: [
        'a hard-block dependency is not yet Done — answerable only once it locks',
      ],
    };
  }
  if (!input.hasOpenQuestionsHeading) {
    return {
      verdict: 'needs-attention',
      reasons: ['task body has no "## Open Questions" heading'],
    };
  }
  if (input.hasRoutedConstraintConflict && input.proposedVerdict === 'clean') {
    return {
      verdict: 'needs-attention',
      reasons: [
        'a binding constraint is dispositioned conflict_route — not clean until the routed Design task resolves',
      ],
    };
  }
  return { verdict: input.proposedVerdict, reasons: [] };
}
