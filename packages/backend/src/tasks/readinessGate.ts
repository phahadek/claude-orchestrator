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

/**
 * Task types whose readiness is about their own scope/method being clear,
 * not about the questions they exist to answer being pre-resolved (see
 * config/task-writing.md § Readiness gate carve-out #4). For these types,
 * Open Questions is the deliverable the task carries into execution — for
 * 📐 Design/📋 Planning it is the /design worklist; for 🔎 Investigation
 * (and observational 🧪 Testing, an Investigation variant) it is the
 * falsification question the task is dispatched to answer, not a defect
 * to clear before Ready. A decision-space body legitimately weighs
 * deferral-shaped phrasing — neither is a readiness violation for these
 * types. checkGroomingResidue still applies to every type.
 */
const OPEN_QUESTIONS_EXEMPT_TYPES: ReadonlySet<string> = new Set([
  '📐 Design',
  '📋 Planning',
  '🔎 Investigation',
  '🧪 Testing',
]);

/**
 * Run the deterministic tiers against a task page body. `type` is the
 * task's display-format Type (e.g. '💻 Code'); when it is 📐 Design,
 * 📋 Planning, 🔎 Investigation, or 🧪 Testing, the Open Questions and
 * deferral-phrase checks are skipped — see OPEN_QUESTIONS_EXEMPT_TYPES.
 * checkGroomingResidue is type-agnostic.
 */
export function checkReadiness(
  body: string | null | undefined,
  type?: string | null,
): ReadinessViolation[] {
  const text = body ?? '';
  const exempt = type != null && OPEN_QUESTIONS_EXEMPT_TYPES.has(type);
  return [
    ...(exempt ? [] : checkOpenQuestionsSection(text)),
    ...(exempt ? [] : checkDeferralPhrases(text)),
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

/**
 * The strip⇔accrete content-verification hard gate (accretion CONTENT
 * verification, not merely "recorded"): parses the non-empty list items
 * under a "👁️ Manual verification" heading (any level) from a task body —
 * the pre-groom candidate set that accreteGateContribution's minted
 * gate_item rows are supposed to account for. Same heading-normalization
 * posture as checkOpenQuestionsSection (normalizeHeadingText strips emoji),
 * so "### 👁️ Manual verification" and "## Manual Verification" both match.
 */
export function parseManualVerificationItems(body: string): string[] {
  const items: string[] = [];
  const lines = body.split('\n');
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s*(.+)$/);
    if (heading) {
      inSection = normalizeHeadingText(heading[1]) === 'manual verification';
      continue;
    }
    if (!inSection) continue;
    const trimmed = line.trim();
    if (!trimmed || /^none$/i.test(trimmed)) continue;
    if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      items.push(
        trimmed
          .replace(/^[-*]\s+/, '')
          .replace(/^\d+[.)]\s+/, '')
          .trim(),
      );
    }
  }
  return items;
}

export interface AccretionContentMatchResult {
  ok: boolean;
  reasons: string[];
}

function normalizeItemText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The strip⇔accrete comparison itself: every item stripped from the task
 * body's source section must correspond to a row actually accreted onto the
 * gate/seed store within the same staged group — the promotion gate this
 * upgrades from "accretion recorded" (a marker exists) to "accretion content
 * matches" (the marker's rows account for what was stripped). Count-based
 * first (accretedItems shorter than strippedItems can never satisfy every
 * stripped item), then item-correspondence by exact normalized text —
 * matching a stripped item against any accreted item, consuming it so a
 * single accreted row can't cover two distinct stripped items. Extra
 * accreted rows beyond strippedItems.length are allowed unmatched: the
 * groomer legitimately adds its own runtime verifications the author didn't
 * foresee (see procedureCore.ts's accrete-gate-and-seed principle), so a
 * larger accreted set is never itself a mismatch. An empty strippedItems is
 * always ok — nothing to account for, and the existing none/n-a accretion
 * path (which mints no items at all) is unaffected by this check.
 */
export function checkAccretionContentMatch(
  label: string,
  strippedItems: string[],
  accretedItems: string[],
): AccretionContentMatchResult {
  if (strippedItems.length === 0) return { ok: true, reasons: [] };

  const remaining = accretedItems.map(normalizeItemText);
  const unmatched: string[] = [];
  for (const stripped of strippedItems) {
    const idx = remaining.indexOf(normalizeItemText(stripped));
    if (idx === -1) {
      unmatched.push(stripped);
    } else {
      remaining.splice(idx, 1);
    }
  }

  if (unmatched.length === 0) return { ok: true, reasons: [] };

  return {
    ok: false,
    reasons: [
      `${label} content mismatch: ${strippedItems.length} item(s) were stripped from the task body but ` +
        `only ${accretedItems.length} were accreted, leaving ${unmatched.length} unmatched — every ` +
        `stripped item must correspond to an accreted row. Unmatched: ${unmatched
          .map((t) => `"${t}"`)
          .join(', ')}.`,
    ],
  };
}
