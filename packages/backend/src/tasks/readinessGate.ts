/**
 * Shared Ready-transition readiness gate (deterministic Tiers 1 & 2 only —
 * see Master Context § Future Scope for the Tier 3 semantic classifier).
 * Imported by both the command layer's Ready-transition validation point
 * (TaskWriteCommands.setStatus) and the /groom session's pre-stage self-check.
 *
 * Tier 1 (structural): a live, non-empty "## Open Questions" heading. A
 * resolved task instead records an "Open questions resolved" summary, which
 * does not match — only the literal live heading is a not-ready signal.
 *
 * Tier 2 (lexical): a curated deferral-phrase list, matched case-insensitively
 * against prose only — occurrences inside fenced code blocks, inline code
 * spans, and block-quoted lines are ignored so a task that merely quotes a
 * phrase is not falsely blocked. Tier 2 also carries a grooming-instruction-
 * residue class (FM2 — see the M12 design task hardening /groom against
 * grooming-integrity failure modes): unambiguous leftover grooming
 * instructions ("confirm ... at grooming", "pin at grooming", "decide during
 * grooming") that should have been resolved before Ready, not carried into
 * the artifact. Deliberately narrow regex patterns, not a bare substring list
 * like `and/or` — that phrase is common in legitimate prose and is instead a
 * Files/paths-section-only hedge token (see groomGate.ts's resolve-in-artifact
 * check), too broad for this general prose scan.
 */

import { renderTaskBodyMarkdown, type TaskBodySections } from './bodyRender';

export interface ReadinessViolation {
  tier: 'structural' | 'lexical';
  detail: string;
  location: string;
}

/**
 * Composes the body the eager gate should evaluate: when a live
 * task.updateBody exists for this task in the same intent group,
 * checkReadiness must see that *proposed* body — updateBody replaces the
 * whole body, so it fully supersedes the stored one — rather than the stale
 * stored body the page still carries until the group actually commits.
 */
export function composeProposedBody(
  storedBody: string,
  proposedSections: TaskBodySections | null | undefined,
): string {
  if (!proposedSections) return storedBody;
  return renderTaskBodyMarkdown(proposedSections);
}

/**
 * Seed list decided at implementation time (task 39a22f91: "Seed list:
 * decide at implementation time..."). Owned by the command layer as an
 * in-repo backend constant — NOT read from the config tree. Runtime-tunable
 * phrase lists are Future Scope.
 */
export const DEFERRAL_PHRASES: readonly string[] = [
  'decide at implementation time',
  'decide during implementation',
  'decided by the implementer',
  'implementer decides',
  'implementer chooses',
  'tbd by impl session',
  'tbd by impl',
  'to be decided during implementation',
  'figure out during implementation',
  'leave to the implementer',
  'determine at implementation time',
];

/**
 * Grooming-instruction residue — unambiguous, seed set (refinable). Each
 * pattern requires both the instruction verb and the "at/during grooming"
 * anchor on the same line so ordinary prose mentioning grooming, or an
 * unrelated "confirm ..."/"pin ..." sentence, doesn't false-positive.
 */
const GROOMING_RESIDUE_PATTERNS: readonly RegExp[] = [
  /\bconfirm\b[^\n]{0,80}\bat grooming\b/i,
  /\bpin\b[^\n]{0,80}\bat grooming\b/i,
  /\bdecide\b[^\n]{0,80}\bduring grooming\b/i,
];

function normalizeHeadingText(text: string): string {
  return text
    .replace(/[^\p{L}\s]/gu, '')
    .trim()
    .toLowerCase();
}

/** Tier 1 — a live, non-empty "## Open Questions" section. */
function checkOpenQuestionsSection(body: string): ReadinessViolation[] {
  const violations: ReadinessViolation[] = [];
  const lines = body.split('\n');
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^#{1,6}\s*(.+)$/);
    if (heading) {
      const normalized = normalizeHeadingText(heading[1]);
      inSection =
        normalized === 'open questions' || normalized === 'open question';
      continue;
    }
    if (!inSection) continue;
    const trimmed = lines[i].trim();
    if (!trimmed || /^none$/i.test(trimmed)) continue;
    violations.push({
      tier: 'structural',
      detail: `Open Questions section is not empty ("${trimmed}")`,
      location: `line ${i + 1}`,
    });
    // One violation for the section is enough signal; stop scanning it.
    inSection = false;
  }
  return violations;
}

/**
 * Blanks out fenced code blocks, inline code spans, and block-quoted lines so
 * Tier 2 matching only sees prose, while preserving line numbers for
 * `location`.
 */
function stripNonProse(body: string): string[] {
  const lines = body.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push('');
      continue;
    }
    if (inFence || /^\s*>/.test(line)) {
      out.push('');
      continue;
    }
    out.push(line.replace(/`[^`]*`/g, ''));
  }
  return out;
}

/** Tier 2 — a curated deferral phrase found in prose. */
function checkDeferralPhrases(body: string): ReadinessViolation[] {
  const violations: ReadinessViolation[] = [];
  const lines = stripNonProse(body);
  lines.forEach((line, idx) => {
    const lower = line.toLowerCase();
    for (const phrase of DEFERRAL_PHRASES) {
      if (lower.includes(phrase)) {
        violations.push({
          tier: 'lexical',
          detail: `deferral phrase "${phrase}" found`,
          location: `line ${idx + 1}`,
        });
      }
    }
  });
  return violations;
}

/** Tier 2 — leftover grooming-instruction residue found in prose. */
function checkGroomingResidue(body: string): ReadinessViolation[] {
  const violations: ReadinessViolation[] = [];
  const lines = stripNonProse(body);
  lines.forEach((line, idx) => {
    for (const pattern of GROOMING_RESIDUE_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        violations.push({
          tier: 'lexical',
          detail: `grooming-instruction residue found ("${match[0].trim()}")`,
          location: `line ${idx + 1}`,
        });
      }
    }
  });
  return violations;
}

/** Run both deterministic tiers against a task page body. */
export function checkReadiness(
  body: string | null | undefined,
): ReadinessViolation[] {
  const text = body ?? '';
  return [
    ...checkOpenQuestionsSection(text),
    ...checkDeferralPhrases(text),
    ...checkGroomingResidue(text),
  ];
}

/**
 * Standard readiness_override reason for a 📐 Design task promoted
 * approve-by-standard (planning/triage.ts) — triaged 'clean' in a
 * consolidated milestone Design triage rather than decided per-item. This is
 * the one human decision approve-by-standard removes for interactive types;
 * every other per-task server-enforced record (checkGroomingPromotionGate)
 * still applies unchanged. `milestoneLabel` is the milestone id the triage
 * ran under (e.g. "M12").
 */
export function standardTriageCleanDesignOverrideReason(
  milestoneLabel: string,
): string {
  return (
    'Design task — open questions are the /design worklist, resolved at execution; ' +
    `triaged clean in the ${milestoneLabel} consolidated Design triage`
  );
}

/** Thrown by the command layer when a Ready transition is blocked. */
export class ReadinessGateError extends Error {
  constructor(public readonly violations: ReadinessViolation[]) {
    super(
      `readiness gate blocked: ${violations
        .map((v) => `[${v.tier}] ${v.detail} (${v.location})`)
        .join('; ')}`,
    );
    this.name = 'ReadinessGateError';
  }
}
