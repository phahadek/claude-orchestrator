import type { GateItemClassification } from '../db/types';

/**
 * Single source of truth for what each gate_item tier means, at the point a
 * session picks one — consumed by the gate.accrete input schema's
 * `.describe()`, the tool description, and the injected planning prompt so
 * the three cannot drift (the same drift hazard PLANNING_INTENT_KINDS
 * parity guards against). Do not inline tier prose anywhere else.
 */
const GATE_ITEM_TIER_DESCRIPTIONS: Record<GateItemClassification, string> = {
  'Read-Only':
    'A check that reads state without changing it — a query, a ' +
    'log/record inspection, a computed-value check. Includes checks that ' +
    "require a live dispatched session to occur: that session's tool " +
    'calls, verdicts and errors land in session_events/audit_log and are ' +
    'readable afterwards, so the check itself is still a read. Also ' +
    'covers a check that requires a bounded scratch write (e.g. seeding ' +
    'one row) purely to produce a trace to read back — the write is ' +
    'instrumental only, never itself the verdict. Not run on demand when ' +
    'the checkable condition has not happened yet: report ' +
    '`not-yet-triggerable` and it parks at `pending` on a backoff ' +
    'schedule until a later re-check.',
  'Prod-Mutating':
    'A check that changes production state to run it (a ' +
    'write, a deploy action, a config apply) — passes stop short of ' +
    'resolving and wait for an explicit approval step. Also eligible for ' +
    '`not-yet-triggerable`/`pending` when the mutating condition has not ' +
    'happened yet.',
  'Human-Observation':
    'Only for what a human must see with their own eyes: ' +
    'rendered UI, colour, layout, wrapping, or a visual read of a running ' +
    'page. A check that merely requires a live dispatched session to occur ' +
    "is NOT Human-Observation for that reason alone — the session's " +
    'record is readable afterwards, so it belongs under Read-Only (or ' +
    'Prod-Mutating) instead. No headless session can ever verify this tier, ' +
    'and it surfaces to an operator with no session-generated evidence ' +
    "trail behind it — so the item's own text must be actionable alone: " +
    'name exactly what to look at (a URL, page, or rendered state) and ' +
    'what a passing observation looks like.',
  'needs-triage':
    'The classification is genuinely unknown and must be ' +
    'resolved by a human triage pass before the item can run in any tier.',
};

const REAL_TIER_ORDER: GateItemClassification[] = [
  'Read-Only',
  'Prod-Mutating',
  'Human-Observation',
];

/**
 * The full tier-selection paragraph — the one place the load-bearing
 * distinction (live-session-required is not Human-Observation) is stated,
 * shared verbatim by the schema field description, the gate.accrete tool
 * description, and the injected procedure-assembler prompt.
 */
export const GATE_ITEM_TIER_SELECTION_GUIDANCE: string =
  'Choosing a classification tier: ' +
  REAL_TIER_ORDER.map(
    (tier) => `"${tier}" — ${GATE_ITEM_TIER_DESCRIPTIONS[tier]}`,
  ).join(' ') +
  ' The distinction most often got wrong: a check that requires a live ' +
  "dispatched session to occur is not Human-Observation — a session's " +
  'tool calls, verdicts and errors are recorded in session_events / ' +
  'audit_log and are readable afterwards. Human-Observation is only for ' +
  'what a human must see: rendered UI, colour, layout, wrapping, or a ' +
  'visual read of a page.';
