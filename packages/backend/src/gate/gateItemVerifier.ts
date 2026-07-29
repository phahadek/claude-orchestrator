import { logger } from '../logger';
import { getProjectById } from '../config';
import { getSession, markSessionDone } from '../db/queries';
import type { SessionManager } from '../session/SessionManager';
import type { GateVerifyDispositionPayload } from '../session/AgentSession';
import {
  renderOpsCapabilities,
  renderProjectRecordAccess,
} from '../planning/procedureAssembler';
import { orchestratorMcpToolName } from '../mcp/toolNaming';
import { appendGateItemEvent } from './gateService';
import type { GateItem } from './gateStore';
import type {
  GateItemVerifier,
  GateVerificationResult,
} from './gateReconciler';

const TERMINAL_SESSION_STATUSES = new Set(['done', 'error', 'killed']);

/**
 * Sessions with a live, un-settled gate-verify appeal in flight — added the
 * instant a `pass` verdict is downgraded and appeal feedback is queued,
 * removed the instant the exchange settles (revised verdict, budget timeout,
 * or the session dying mid-appeal). Checked by AgentSession.handleCleanExit
 * so a gate-verify session's one-shot auto-teardown does not archive it out
 * from under its own pending appeal — mirroring the guard that path already
 * has for an outstanding `session.requestCapability` intent.
 */
const pendingGateVerifyAppeal = new Set<string>();

/** True if `sessionId` has an outstanding gate-verify appeal awaiting its one revision. */
export function hasPendingGateVerifyAppeal(sessionId: string): boolean {
  return pendingGateVerifyAppeal.has(sessionId);
}

export interface SessionGateItemVerifierOptions {
  /** Wall-clock budget for one verify dispatch before abstaining to needs-setup. Default 20 minutes. */
  budgetMs?: number;
  /** Poll interval while awaiting the dispatched session's terminal status, as a fallback net alongside the event subscription. Default 5s. */
  pollIntervalMs?: number;
}

const DEFAULT_BUDGET_MS = 20 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * The gate-verify injected procedure: a bounded best-effort single-item
 * read-history doctrine, assembled and passed as the session's
 * `injectedProcedureContent` — the same seam a groom/design/ops-planning
 * session gets via `procedureAssembler.assemblePlanningProcedure`. Passing
 * it this way makes `SessionManager.start` use it verbatim and skip
 * `buildOrchestratorClaudeMd` (the implement/branch/Pre-PR-Gate/open-PR/
 * review-loop coding scaffold), which has no business in a worktree-less,
 * read-only verification session. The session never runs a vendored skill
 * to assemble this itself.
 */
function buildGateVerifyProcedure(item: GateItem): string {
  const isHumanObservation = item.classification === 'Human-Observation';
  return [
    '## Session Lifecycle',
    '',
    'This is an injected, non-interactive, one-shot gate-verification ' +
      `session dispatched to settle a single Manual Verification Gate item ` +
      `(${item.id}). It is not auto-dispatched onto anything else. There is ` +
      'no worktree and no feature branch, and this session never stages ' +
      'code, opens a PR, or drives an ops_journal transition — it is ' +
      'strictly read-only against the operational record and, at most, a ' +
      'brief source orient (see "Procedure" below). Its only job is to ' +
      'investigate and report exactly one disposition, then end the turn — ' +
      'there is no follow-up loop or review cycle to wait for.',
    '',
    '### Gate item',
    '',
    `- id: ${item.id}`,
    `- project: ${item.project}`,
    `- milestone: ${item.milestone}`,
    `- classification: ${item.classification}`,
    `- text: ${item.text}`,
    '',
    ...renderProjectRecordAccess('ops', item.project),
    ...renderOpsCapabilities(),
    '### Procedure',
    '',
    "This item's associated PR(s) are already merged and deployed — that " +
      'guarantee is *why* this verification session exists (the item only ' +
      'becomes runnable and launches a verifier once merged and deployed). ' +
      'Spend zero turns re-confirming that: not `git merge-base ' +
      '--is-ancestor`, not "is the PR merged", not "was it deployed". That ' +
      'check is tautologically true by construction and proves nothing ' +
      'about whether the described behavior actually works — it is a ' +
      'guaranteed precondition, not evidence the behavior holds. Go ' +
      'straight to the behavior.',
    '',
    'Start with the operational record, not the source tree — opening on ' +
      '`grep`/`find`/`Read` over packages/*/src to understand a mechanism ' +
      'is a known failure mode for this session: it burns the turn budget ' +
      'without ever checking whether the behavior actually ran.',
    '',
    "**The operational record IS** — the running system's behavioral " +
      'trace. A pass must cite one of these:',
    '- `audit_log` entries',
    '- `session_events`',
    '- live DB/API state',
    '- an observed runtime occurrence of the described behavior',
    '',
    '**The operational record is NOT** — preconditions and source, ' +
      'guaranteed true by this item being runnable at all, never pass ' +
      'evidence:',
    '- pull requests',
    '- git history',
    '- `gh` output',
    '- a merged PR',
    '- a deploy record',
    '- CI checks',
    '- source code',
    '- unit tests',
    '',
    'Your job, in one line: validate the described behavior by its runtime ' +
      'trace. If there is no such trace, or you cannot read it, abstain ' +
      '(`needs-setup`) or reclassify (`Human-Observation`) — never ' +
      'substitute a precondition or source reading for it.',
    '',
    'This is a bounded best-effort read: settle within your time/turn ' +
      'budget, or abstain. Never stage, commit, or mutate anything, and ' +
      'never call a gate-write API — you have no gate-write authority; the ' +
      'backend is the only writer of gate state, and treats this report as ' +
      'evidence, not a command. Auto-pass only on clear, direct evidence; ' +
      'if you cannot conclusively determine pass or fail, report ' +
      'needs-setup — abstain rather than guess.',
    '',
    'This session is responsible for asking for what it needs: nothing beyond ' +
      'its base read/stage profile is ever speculatively handed to it. If ' +
      "settling this item genuinely requires reading this orchestrator's own " +
      "runtime record (session_events/audit_log for a session you're verifying), " +
      'request the own-record read (see "Capabilities" above — ' +
      '`read:session-record:<target-session-id>`), not a Bash prefix like ' +
      '`sqlite3` or a direct filesystem/DB path. This is a tool-set boundary, ' +
      'not a location one: this session spawns with broad filesystem access ' +
      "(it can read the orchestrator checkout and the box's local files), but " +
      'it holds no allow-listed client for the live SQLite file and no device ' +
      "auth for the orchestrator's API — so session_events/audit_log for a " +
      'specific session stay reachable only through the brokered read, not a ' +
      "direct file or DB path. For any other read your base tools don't " +
      'cover, stage a `session.requestCapability` intent naming that exact read ' +
      'and end the turn — an operator grant resumes you with it. If that is not ' +
      'practical for a bounded one-shot investigation, report `needs-setup` and ' +
      'name the missing capability. Never fabricate a pass/fail to route around ' +
      'a permission denial — a blocked read is grounds for needs-setup, not for ' +
      'guessing.',
    '',
    '**Before abstaining for a missing identifier** (e.g. "no target session ' +
      'ID to read"): exhaust the record surfaces your base tools already ' +
      'reach — do not jump straight to needs-setup just because you lack a ' +
      "specific ID up front. A known one is this box's dispatched-session " +
      'prompt corpus, `.claude/session-prompts/<sessionId>.md` inside a ' +
      "project's checkout — the filenames are session ids and the contents " +
      'name the workflow they were dispatched for, so `ls`/`grep`/`find` over ' +
      'that directory (all in your base Bash set) can surface the very ' +
      'session id(s) you need without any capability grant. Also check ' +
      "`git log`, this project's other local session-prompt/journal " +
      'artifacts, and any other base-tool-reachable surface that might name ' +
      'the identifier before concluding none exists. A `needs-setup` ' +
      'disposition that cites a missing identifier must say what you ' +
      'searched (e.g. "checked .claude/session-prompts/, found no matching ' +
      'dispatch") — an abstention with no record of a local search is ' +
      'incomplete, not a valid bounded-effort result.',
    '',
    'Source is, at most, a brief orient — a quick, targeted look to confirm ' +
      'you are reading the right code path once the operational record has ' +
      'pointed you at one, never the vehicle for the investigation itself ' +
      'and never its verification body. A `pass` disposition must never ' +
      'rest on source-code reading alone — it must be grounded in one of ' +
      'the operational-record items listed above (audit_log, ' +
      'session_events, live DB/API state, an observed runtime occurrence). ' +
      'If the strongest evidence you found is "the source code looks like ' +
      'it does X", that is not a pass — report needs-setup and explain ' +
      'what operational trace is missing. Set `evidence.basis` to ' +
      '"operational" only when your pass is actually backed by such a ' +
      'trace; set it to "source" when you only read source code. A `pass` ' +
      'with `evidence.basis` other than "operational" will be downgraded ' +
      'to needs-setup regardless of what you report.',
    '',
    ...(isHumanObservation
      ? [
          'This item is classified **Human-Observation**: it describes ' +
            'UI/visual/interactive behavior (e.g. a rendered component, a ' +
            'visual layout, an interactive flow) that only a human observing ' +
            'the running app can judge. You cannot pass this item — reading ' +
            'component source to infer what renders is not verification. ' +
            'Always report `needs-setup`, even if you find strong ' +
            'operational evidence; attach whatever you found as advisory ' +
            'evidence for the human who will make the actual pass/fail call ' +
            'through the /gate flow.',
          '',
        ]
      : [
          'If, while investigating, you determine this item is ' +
            'mis-classified — most commonly, it actually describes ' +
            'UI/visual/interactive behavior that only a human observing the ' +
            'running app can judge, but it is tagged an auto-run tier ' +
            '(Read-Only/Opportunistic/Prod-Mutating) so this session was ' +
            'dispatched to headlessly verify something it structurally ' +
            'cannot observe — propose the correct classification instead ' +
            'of forcing a pass/fail, or abstaining to a bare needs-setup ' +
            'that leaves the same mis-routing to recur next time. You may ' +
            'only propose `Human-Observation` (this is that case) or ' +
            '`needs-triage` (you cannot tell what tier actually fits and a ' +
            'human should decide) — never an auto-run tier. Include it as ' +
            'a `reclassify` field alongside your disposition (typically ' +
            '`needs-setup`, since you are also abstaining on this run); ' +
            'the backend applies it and re-routes the item, it does not ' +
            'change what you report for `disposition`.',
          '',
          'This same routing applies, not just to a visibly wrong tier tag, ' +
            'but whenever your investigation establishes that no ' +
            'operational trace of the described behavior can exist by ' +
            'construction — e.g. you traced the code path that would ' +
            'produce it and confirmed it never records one, by design, not ' +
            'merely that you could not find one within this run. That is a ' +
            'distinct outcome from a bounded-effort abstention: "I ran out ' +
            'of turn/time budget" or "I lack a capability to read the ' +
            'record" stays a plain `needs-setup` with no reclassify — the ' +
            'item may still be settleable another way. But "this item ' +
            'cannot be settled from the operational record, period, ' +
            'because the record is structurally never produced" means the ' +
            'item is mis-routed the same way a wrongly-tagged UI item is, ' +
            'and the correct response is a `reclassify` proposal ' +
            '(`Human-Observation` or `needs-triage`) alongside your ' +
            '`needs-setup` — never a bare `needs-setup` that leaves the ' +
            'item sitting in an auto-run tier for the next verifier to ' +
            'hit the same wall.',
          '',
        ]),
    `Report your finding by calling the \`${orchestratorMcpToolName('gate.verify')}\` tool ` +
      'exactly once, as your final action — never a chat JSON block, which is ' +
      'not delivered anywhere. `reclassify` is required whenever you ' +
      'concluded the item cannot be settled from the operational record by ' +
      'construction (see above) — omit it only for a genuine pass/fail or a ' +
      'bounded-effort abstention that does not rest on structural ' +
      'unverifiability:',
    '',
    '```json',
    `{"gateItemId": "${item.id}", "disposition": "pass"|"fail"|"needs-setup", "evidence": {"basis": "operational"|"source", "...": "..."}, "reclassify": {"to": "Human-Observation"|"needs-triage", "reason": "..."}}`,
    '```',
  ].join('\n');
}

/**
 * The one-shot appeal message delivered via SessionManager.enqueueFeedback
 * when a `pass` verdict is downgraded by enforcePassEvidenceContract while
 * the session is still live. Names the specific clause that failed (never a
 * generic rejection) and states plainly that this is the session's one and
 * only chance to revise — a second verdict, whatever it is, is final.
 */
function buildGateVerifyAppealMessage(
  item: GateItem,
  downgradeReason: string,
  originalEvidence: unknown,
): string {
  return [
    `Your \`pass\` disposition for gate item ${item.id} was downgraded ` +
      'before being finalized — the pass-evidence contract rejected it:',
    '',
    `> ${downgradeReason}`,
    '',
    'This is your one chance to revise, and the only one: whatever you ' +
      'report next is final, appealed or not. If you have (or can now ' +
      'gather) evidence that actually satisfies the contract — a concrete ' +
      'captured runtime record (audit_log, session_events, a live DB/API ' +
      'read, or an observed runtime occurrence), not source/CI-grade ' +
      'evidence and not a guaranteed precondition (PR merged/deployed) — ' +
      `report it now by calling \`${orchestratorMcpToolName('gate.verify')}\` ` +
      `again for gate item ${item.id} with your revised disposition and ` +
      'evidence.',
    '',
    'If you cannot produce evidence that satisfies the contract, report ' +
      '`needs-setup` instead of repeating the same pass — a second pass ' +
      'that still fails the contract is downgraded the same way, with no ' +
      'further appeal.',
    '',
    'Your original reported evidence was:',
    '```json',
    JSON.stringify(originalEvidence ?? null, null, 2),
    '```',
  ].join('\n');
}

/**
 * The symmetric one-shot appeal to `buildGateVerifyAppealMessage`, for the
 * other half of the disposition contract: a `needs-setup` whose own evidence
 * establishes that no operational trace of the described behavior can exist
 * by construction, reported with no accompanying `reclassify`. Names the
 * omission plainly and states this is the session's one and only chance to
 * add one — a second verdict, reclassify or not, is final.
 */
function buildGateVerifyReclassifyAppealMessage(
  item: GateItem,
  originalEvidence: unknown,
): string {
  return [
    `Your \`needs-setup\` disposition for gate item ${item.id} reads as ` +
      'having established that no operational trace of the described ' +
      'behavior can exist by construction — not merely that you could not ' +
      'find one within this run — but it did not include a `reclassify` ' +
      'field.',
    '',
    'That is the outcome the disposition contract asks you to route ' +
      'differently: a bare `needs-setup` here leaves the item sitting in ' +
      'its current (auto-run) tier, to be handed to another verifier that ' +
      'will hit the same structural wall and report the same abstention, ' +
      'indefinitely.',
    '',
    'This is your one chance to revise, and the only one: whatever you ' +
      'report next is final, appealed or not. If your conclusion stands, ' +
      `report it again by calling \`${orchestratorMcpToolName('gate.verify')}\` ` +
      `for gate item ${item.id} with the same \`needs-setup\` disposition, ` +
      'this time alongside a `reclassify` field proposing `Human-Observation` ' +
      '(if the item needs a human to judge it) or `needs-triage` (if you ' +
      'cannot tell what tier fits and a human should decide) — never an ' +
      'auto-run tier. If on reflection this was actually a bounded-effort ' +
      'abstention (budget/capability limited, not structural), report ' +
      '`needs-setup` again with no `reclassify` and explain that instead.',
    '',
    'Your original reported evidence was:',
    '```json',
    JSON.stringify(originalEvidence ?? null, null, 2),
    '```',
  ].join('\n');
}

/**
 * The result of trying to read an evidence payload as an object. A session
 * may report evidence as a JSON string rather than an object — that must be
 * parsed and then judged on its contents, not rejected on shape alone. A
 * string that cannot be parsed into an object is a distinct failure mode
 * ("shape") from an object whose contents don't satisfy the contract
 * ("substance") and must be reported differently.
 */
type EvidenceShapeResult =
  | { kind: 'object'; value: Record<string, unknown> }
  | { kind: 'unusable' }
  | { kind: 'shape-error'; description: string };

/**
 * Parses an evidence payload into an object, accepting either an object
 * directly or a JSON-encoded string of one.
 */
function resolveEvidenceShape(evidence: unknown): EvidenceShapeResult {
  if (typeof evidence === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(evidence);
    } catch {
      return {
        kind: 'shape-error',
        description: 'a string that could not be parsed as JSON',
      };
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { kind: 'object', value: parsed as Record<string, unknown> };
    }
    return {
      kind: 'shape-error',
      description: `a JSON string that parsed to ${
        Array.isArray(parsed)
          ? 'an array'
          : parsed === null
            ? 'null'
            : typeof parsed
      }, not an object`,
    };
  }
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    return { kind: 'object', value: evidence as Record<string, unknown> };
  }
  return { kind: 'unusable' };
}

function toEvidenceObject(evidence: unknown): Record<string, unknown> | null {
  const resolved = resolveEvidenceShape(evidence);
  return resolved.kind === 'object' ? resolved.value : null;
}

/**
 * True when a `pass` result's evidence claims to be grounded in
 * operational/runtime observation rather than source-code reading alone.
 * Exported for testing.
 */
export function hasOperationalEvidence(evidence: unknown): boolean {
  const value = toEvidenceObject(evidence);
  if (!value) return false;
  const basis = value.basis;
  if (typeof basis === 'string') {
    return basis.toLowerCase() === 'operational';
  }
  if (Array.isArray(basis)) {
    return basis.some(
      (b) => typeof b === 'string' && b.toLowerCase() === 'operational',
    );
  }
  return false;
}

/**
 * Tokens that describe a guaranteed precondition (the source PR merged, the
 * commit deployed, an ancestry check) rather than evidence the described
 * behavior actually occurred. These are mechanical/tautological by the time
 * any verifier runs — the runnable-gate already guarantees merged+deployed —
 * so confirming them proves nothing about the behavior.
 */
const PRECONDITION_TOKENS = new Set([
  'merge-base',
  'is-ancestor',
  'ancestor',
  'merged',
  'deployed',
]);

/**
 * Filler tokens (evidence-envelope vocabulary, connectives, PR/commit
 * nouns) that carry no behavioral content on their own and are ignored
 * when deciding whether anything substantive remains.
 */
const FILLER_TOKENS = new Set([
  'basis',
  'operational',
  'source',
  'reason',
  'evidence',
  'sessionid',
  'note',
  'confirmed',
  'confirming',
  'verified',
  'checked',
  'via',
  'git',
  'ran',
  'run',
  'the',
  'is',
  'was',
  'and',
  'that',
  'it',
  'which',
  'through',
  'pr',
  'commit',
  'to',
  'into',
  'already',
  'after',
  'production',
  'main',
  'dev',
  'master',
]);

const WORD_SPLIT_PATTERN = /[^a-z0-9-]+/;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(WORD_SPLIT_PATTERN)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
}

/**
 * True when a `pass` result's evidence, after discarding guaranteed-
 * precondition tokens (merged, deployed, ancestry checks) and filler
 * vocabulary, has no substantive tokens left — i.e. the evidence amounts to
 * confirming a precondition the item was already guaranteed to satisfy,
 * never to observing the described behavior itself. Exported for testing.
 */
export function isPreconditionOnlyEvidence(evidence: unknown): boolean {
  const value = toEvidenceObject(evidence);
  if (!value) return false;
  const tokens = tokenize(JSON.stringify(value));
  const hasPreconditionToken = tokens.some((t) => PRECONDITION_TOKENS.has(t));
  if (!hasPreconditionToken) return false;

  const remaining = tokens.filter(
    (t) =>
      !PRECONDITION_TOKENS.has(t) &&
      !FILLER_TOKENS.has(t) &&
      !/^[0-9a-f]+$/.test(t),
  );
  return remaining.length === 0;
}

function evidenceText(evidence: unknown): string | null {
  const value = toEvidenceObject(evidence);
  if (!value) return null;
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Tokens naming a store/channel this codebase actually captures runtime
 * activity into (a live API or DB read), paired with an action token that
 * shows it was read rather than merely mentioned in passing.
 */
const RUNTIME_STORE_TOKENS = new Set(['api', 'database', 'db']);
const RUNTIME_ACTION_TOKENS = new Set([
  'read',
  'call',
  'query',
  'queried',
  'response',
  'record',
  'live',
  'fetched',
  'fetch',
]);

/**
 * True when a `pass` result's evidence names a concrete captured runtime
 * record — `session_events`, `audit_log`, or a live API/DB read — rather
 * than resting on source/CI-grade evidence (a CI check, a test file, a
 * source-path trace) that never touches a runtime record at all. Exported
 * for testing.
 */
export function hasConcreteRuntimeRecordEvidence(evidence: unknown): boolean {
  const text = evidenceText(evidence);
  if (!text) return false;
  if (/audit_log/.test(text) || /session_events/.test(text)) return true;
  const tokens = tokenize(text);
  const mentionsStore = tokens.some((t) => RUNTIME_STORE_TOKENS.has(t));
  if (!mentionsStore) return false;
  return tokens.some((t) => RUNTIME_ACTION_TOKENS.has(t));
}

const LIVE_RECORD_UNREACHABLE_SIGNAL_TOKENS = new Set([
  'unreachable',
  'inaccessible',
  'unavailable',
]);
const NEGATION_TOKENS = new Set([
  'no',
  'not',
  'unable',
  'couldnt',
  'didnt',
  'never',
  'failed',
  'without',
]);
const LIVE_RECORD_MENTION_TOKENS = new Set([
  'live',
  'record',
  'audit',
  'log',
  'session',
  'events',
  'database',
  'db',
  'api',
  'operational',
]);

/**
 * True when the evidence itself carries a limitation/caveat admitting the
 * live/operational record was not or could not be read — a self-reported
 * admission that the substantive claim rests on inference rather than a
 * captured runtime record. A pass paired with an admission like this is
 * downgraded regardless of what else the evidence names. Exported for
 * testing.
 */
export function admitsLiveRecordUnreachable(evidence: unknown): boolean {
  const text = evidenceText(evidence);
  if (!text) return false;
  const tokens = tokenize(text);
  if (tokens.some((t) => LIVE_RECORD_UNREACHABLE_SIGNAL_TOKENS.has(t))) {
    return true;
  }
  const hasNegation = tokens.some((t) => NEGATION_TOKENS.has(t));
  const hasLiveRecordMention = tokens.some((t) =>
    LIVE_RECORD_MENTION_TOKENS.has(t),
  );
  return hasNegation && hasLiveRecordMention;
}

/**
 * Tokens naming a structural/by-construction reason evidence can't exist —
 * paired with a negation token and a record-surface mention, this signals a
 * `needs-setup` that has established the item can never be settled from the
 * operational record (as opposed to merely not being settled within this
 * run's budget).
 */
const STRUCTURAL_UNVERIFIABILITY_SIGNAL_TOKENS = new Set([
  'design',
  'construction',
  'structurally',
  'structural',
]);

/**
 * True when `needs-setup` evidence asserts that no operational trace of the
 * described behavior can exist by construction — e.g. "this code path never
 * calls recordEvent, so no audit_log entry is produced by design" — rather
 * than a bounded-effort abstention that merely ran out of budget or lacked a
 * capability grant this run. The former is the case this task's appeal
 * targets: a session that reaches this conclusion but reports a bare
 * `needs-setup` with no `reclassify` has left the item mis-routed. Exported
 * for testing.
 */
export function assertsStructuralUnverifiability(evidence: unknown): boolean {
  const text = evidenceText(evidence);
  if (!text) return false;
  const tokens = tokenize(text);
  const hasStructuralSignal = tokens.some((t) =>
    STRUCTURAL_UNVERIFIABILITY_SIGNAL_TOKENS.has(t),
  );
  if (!hasStructuralSignal) return false;
  const hasNegation = tokens.some((t) => NEGATION_TOKENS.has(t));
  const hasRecordMention = tokens.some((t) =>
    LIVE_RECORD_MENTION_TOKENS.has(t),
  );
  return hasNegation && hasRecordMention;
}

/**
 * Tokens naming an identifier the session might be missing (a target
 * session id, a record id) — paired with a negation token, this signals a
 * `needs-setup` blaming "I don't have an ID to look up."
 */
const MISSING_IDENTIFIER_TOKENS = new Set([
  'id',
  'identifier',
  'sessionid',
  'target',
]);

/**
 * Tokens showing the session actually looked somewhere locally before
 * abstaining — either a generic search verb or the name of a known
 * base-tool-reachable surface (the dispatched-session prompt corpus).
 */
const SEARCH_EVIDENCE_TOKENS = new Set([
  'searched',
  'search',
  'checked',
  'looked',
  'grep',
  'grepped',
  'ls',
  'find',
  'listed',
  'scanned',
  'prompts',
  'session-prompts',
  'sessionprompts',
]);

/**
 * True when `needs-setup` evidence blames a missing identifier (e.g. "no
 * target session ID") without recording that any base-tool-reachable local
 * surface (e.g. `.claude/session-prompts/`) was actually searched for one —
 * the abstention this task exists to close off, where a session gives up on
 * "I have no ID" without ever having looked locally for one. Exported for
 * testing.
 */
export function citesMissingIdentifierWithoutSearch(
  evidence: unknown,
): boolean {
  const text = evidenceText(evidence);
  if (!text) return false;
  const tokens = tokenize(text);
  const citesMissingIdentifier =
    tokens.some((t) => NEGATION_TOKENS.has(t)) &&
    tokens.some((t) => MISSING_IDENTIFIER_TOKENS.has(t));
  if (!citesMissingIdentifier) return false;
  return !tokens.some((t) => SEARCH_EVIDENCE_TOKENS.has(t));
}

function downgrade(
  reason: string,
  reportedEvidence: unknown,
  reclassify?: GateVerificationResult['reclassify'],
): GateVerificationResult {
  return {
    disposition: 'needs-setup',
    evidence: { reason, reportedEvidence },
    reclassify,
  };
}

/**
 * The disposition contract's enforcement half of "no pass on source alone,
 * no pass on a guaranteed precondition alone, no pass without a concrete
 * captured runtime record, no pass alongside a self-admitted unreachable
 * record": a `pass` disposition is downgraded to `needs-setup` unless its
 * evidence claims operational grounding, doesn't rest solely on a
 * guaranteed/mechanical precondition (PR merged, commit deployed), names a
 * concrete captured runtime record (session_events, audit_log, or a live
 * API/DB read) rather than source/CI-grade evidence (a CI check, a test
 * file, a source-path trace), and carries no limitation admitting the live
 * record was unreachable — the prompt asks nicely, this backstops it
 * regardless of what the session actually reported. Exported for testing.
 */
export function enforcePassEvidenceContract(
  result: GateVerificationResult,
): GateVerificationResult {
  if (result.disposition !== 'pass') return result;
  const shape = resolveEvidenceShape(result.evidence);
  if (shape.kind === 'shape-error') {
    return downgrade(
      `pass disposition's evidence could not be interpreted as an evidence ` +
        `object (it was ${shape.description}) — this is a shape problem, ` +
        'not a judgment that the evidence was source-only, and no ' +
        'operational/source determination could be made',
      result.evidence,
      result.reclassify,
    );
  }
  if (!hasOperationalEvidence(result.evidence)) {
    return downgrade(
      'pass disposition lacked operational/runtime evidence — a source-only verdict cannot pass',
      result.evidence,
      result.reclassify,
    );
  }
  if (isPreconditionOnlyEvidence(result.evidence)) {
    return downgrade(
      'pass disposition was grounded only in a guaranteed precondition (PR merged/deployed) or other mechanical check — that proves nothing about whether the described behavior holds',
      result.evidence,
      result.reclassify,
    );
  }
  if (admitsLiveRecordUnreachable(result.evidence)) {
    return downgrade(
      "pass disposition's evidence admits the live/operational record was not or could not be read — a self-reported limitation like this cannot be paired with a pass",
      result.evidence,
      result.reclassify,
    );
  }
  if (!hasConcreteRuntimeRecordEvidence(result.evidence)) {
    return downgrade(
      'pass disposition rested on source/CI-grade evidence (a CI check, a test file, a source-path trace) rather than a concrete captured runtime record (session_events, audit_log, or a live API/DB read)',
      result.evidence,
      result.reclassify,
    );
  }
  return result;
}

/**
 * The disposition contract's abstention half: a `needs-setup` that blames a
 * missing identifier must record that a local, base-tool-reachable surface
 * (e.g. `.claude/session-prompts/`) was actually searched for one before
 * abstaining — an abstention with no record of a local search is
 * incomplete, not a valid bounded-effort result (see the "Before
 * abstaining for a missing identifier" guidance in
 * `buildGateVerifyProcedure`). There is no disposition below `needs-setup`
 * to downgrade to, so this annotates the evidence instead of changing the
 * disposition, leaving the incompleteness visible to whoever reconciles or
 * re-dispatches the item next. Exported for testing.
 */
export function enforceAbstentionEvidenceContract(
  result: GateVerificationResult,
): GateVerificationResult {
  if (result.disposition !== 'needs-setup') return result;
  if (!citesMissingIdentifierWithoutSearch(result.evidence)) return result;
  const baseEvidence = toEvidenceObject(result.evidence) ?? {
    reportedEvidence: result.evidence,
  };
  return {
    ...result,
    evidence: {
      ...baseEvidence,
      abstentionIncomplete: true,
      abstentionNote:
        'needs-setup cites a missing identifier but does not record what ' +
        'local, base-tool-reachable record surfaces (e.g. ' +
        '.claude/session-prompts/) were searched for it before abstaining',
    },
  };
}

/**
 * The production GateItemVerifier: dispatches a gate-item-scoped read-only
 * investigation session (the 'ops' session kind — no worktree, no PR, no
 * grant-on-re-dispatch) and awaits its terminal gate_verify report.
 *
 * Bounded best-effort: abstains to needs-setup on budget exhaustion, a
 * crashed/killed session, or an unparseable/missing report. Auto-pass only
 * ever comes from a session's clear, self-reported pass block — never
 * inferred.
 */
export class SessionGateItemVerifier implements GateItemVerifier {
  private readonly budgetMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly sessionManager: SessionManager,
    options: SessionGateItemVerifierOptions = {},
  ) {
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async verify(item: GateItem): Promise<GateVerificationResult> {
    const project = getProjectById(item.project);
    if (!project) {
      return {
        disposition: 'needs-setup',
        evidence: { reason: `unknown project ${item.project}` },
      };
    }

    // Register a capture listener before start() dispatches the session — a
    // fast session can emit gate_verify_disposition before start() even
    // resolves, and without a listener already attached that event is lost
    // (the poll fallback would then wrongly record a needs-setup timeout
    // instead of the session's actual verdict). We don't know sessionId yet,
    // so buffer every disposition and filter by sessionId once start()
    // resolves.
    const captured: GateVerifyDispositionPayload[] = [];
    const capture = (payload: GateVerifyDispositionPayload) => {
      captured.push(payload);
    };
    this.sessionManager.on('gate_verify_disposition', capture);

    let sessionId: string;
    try {
      sessionId = await this.sessionManager.start(item.id, project.contextUrl, {
        projectId: item.project,
        taskName: `Gate verify: ${item.text}`,
        sessionType: 'ops',
        taskKind: 'non_milestone',
        taskId: `gate-item:${item.id}`,
        injectedProcedureContent: buildGateVerifyProcedure(item),
      });
    } catch (err) {
      this.sessionManager.off('gate_verify_disposition', capture);
      return {
        disposition: 'needs-setup',
        evidence: {
          reason: 'failed to dispatch verification session',
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
    this.sessionManager.off('gate_verify_disposition', capture);
    const preCaptured = captured.find((p) => p.sessionId === sessionId);

    return this.awaitDisposition(item, sessionId, preCaptured);
  }

  /**
   * Awaits the dispatched session's disposition, applying the pass/abstention
   * evidence contracts while the session is still live — ahead of teardown,
   * not after it — so a contract-downgraded `pass` can be routed back to the
   * session as a one-shot appeal instead of being silently discarded onto a
   * now-dead session (see the module-level contract-enforcement doc above
   * enforcePassEvidenceContract). The exchange is capped end-to-end by the
   * same budget/poll timers regardless of whether an appeal happens.
   */
  private awaitDisposition(
    item: GateItem,
    sessionId: string,
    preCaptured?: GateVerifyDispositionPayload,
  ): Promise<GateVerificationResult> {
    return new Promise((resolve) => {
      let settled = false;
      // Set once an appeal is sent; the *next* disposition report is treated
      // as the one revision and is final regardless of outcome — no second
      // appeal is ever offered.
      let appealInFlight = false;
      // The contract-downgraded result an in-flight appeal would fall back to
      // if the session never answers (budget exhaustion or the session dying
      // mid-appeal) — the downgrade stands as final in that case.
      let appealFallback: GateVerificationResult | null = null;
      const handles: {
        poll?: ReturnType<typeof setInterval>;
        budget?: ReturnType<typeof setTimeout>;
      } = {};

      const teardown = (result: GateVerificationResult) => {
        if (settled) return;
        settled = true;
        if (handles.poll) clearInterval(handles.poll);
        if (handles.budget) clearTimeout(handles.budget);
        this.sessionManager.off('gate_verify_disposition', onDisposition);
        pendingGateVerifyAppeal.delete(sessionId);
        // The disposition has now been consumed by the reconciler's caller —
        // this one-shot session has no resume purpose from here on (a
        // re-verify dispatches a fresh session), so archive it and reap its
        // subprocess rather than let it linger holding a concurrency slot.
        // Skip sessions already terminal (error/killed — AgentSession owns
        // those transitions) or already archived by the session's own
        // clean-exit path.
        const row = getSession(sessionId);
        if (
          row &&
          row.status !== 'error' &&
          row.status !== 'killed' &&
          row.status !== 'done'
        ) {
          markSessionDone(
            sessionId,
            Date.now(),
            null,
            'gate_item_verifier_consumed',
          );
          this.sessionManager.archiveAndEndSession(sessionId);
        }
        resolve(result);
      };

      const applyContracts = (
        result: GateVerificationResult,
      ): GateVerificationResult =>
        enforceAbstentionEvidenceContract(enforcePassEvidenceContract(result));

      const toResult = (
        payload: GateVerifyDispositionPayload,
      ): GateVerificationResult => ({
        disposition: payload.disposition.disposition,
        evidence: payload.disposition.evidence ?? { sessionId },
        reclassify: payload.disposition.reclassify,
      });

      /** Shared one-shot-appeal mechanics: marks the appeal in flight, records the pre-appeal verdict, and enqueues the appeal feedback. */
      const sendAppeal = (
        fallback: GateVerificationResult,
        eventEvidence: Record<string, unknown>,
        message: string,
        feedbackKind: string,
      ) => {
        appealInFlight = true;
        appealFallback = fallback;
        pendingGateVerifyAppeal.add(sessionId);
        appendGateItemEvent(item.id, {
          disposition: 'noted',
          operator: 'gate-verifier',
          evidence: eventEvidence,
        });
        this.sessionManager
          .enqueueFeedback(sessionId, feedbackKind, message)
          .catch((err) => {
            logger.error(
              `[GateItemVerifier] failed to enqueue gate-verify appeal for session ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`,
            );
          });
      };

      /** Sends the one-shot appeal for a `pass` downgraded by the evidence contract, recording the original verdict first so it survives the appeal un-overwritten. */
      const startAppeal = (
        raw: GateVerificationResult,
        contractChecked: GateVerificationResult,
      ) => {
        const downgradeReason =
          (contractChecked.evidence as { reason?: string } | undefined)
            ?.reason ?? 'pass evidence contract violation';
        sendAppeal(
          contractChecked,
          {
            appeal: 'original-verdict',
            originalDisposition: raw.disposition,
            originalEvidence: raw.evidence,
            downgradeReason,
          },
          buildGateVerifyAppealMessage(item, downgradeReason, raw.evidence),
          'gate-verifier:appeal',
        );
      };

      /** Sends the symmetric one-shot appeal for a `needs-setup` that establishes structural unverifiability but omits `reclassify`. */
      const startReclassifyOmissionAppeal = (
        result: GateVerificationResult,
      ) => {
        sendAppeal(
          result,
          {
            appeal: 'reclassify-omission',
            originalDisposition: result.disposition,
            originalEvidence: result.evidence,
          },
          buildGateVerifyReclassifyAppealMessage(item, result.evidence),
          'gate-verifier:reclassify-appeal',
        );
      };

      /** Handles one reported disposition — either the first attempt or the one appeal revision. */
      const handleReport = (raw: GateVerificationResult) => {
        if (appealInFlight) {
          // The revision — final either way, no further appeal offered.
          appealInFlight = false;
          teardown(applyContracts(raw));
          return;
        }
        const contractChecked = enforcePassEvidenceContract(raw);
        const isPassDowngrade =
          raw.disposition === 'pass' && contractChecked.disposition !== 'pass';
        const row = getSession(sessionId);
        const sessionTerminal =
          !!row && TERMINAL_SESSION_STATUSES.has(row.status);
        if (isPassDowngrade) {
          if (sessionTerminal) {
            // No live session left to appeal to.
            teardown(enforceAbstentionEvidenceContract(contractChecked));
            return;
          }
          startAppeal(raw, contractChecked);
          return;
        }
        const abstained = enforceAbstentionEvidenceContract(contractChecked);
        if (
          !sessionTerminal &&
          abstained.disposition === 'needs-setup' &&
          !abstained.reclassify &&
          assertsStructuralUnverifiability(abstained.evidence)
        ) {
          startReclassifyOmissionAppeal(abstained);
          return;
        }
        teardown(abstained);
      };

      const onDisposition = (payload: GateVerifyDispositionPayload) => {
        if (payload.sessionId !== sessionId) return;
        handleReport(toResult(payload));
      };

      this.sessionManager.on('gate_verify_disposition', onDisposition);

      handles.poll = setInterval(() => {
        const row = getSession(sessionId);
        if (row && TERMINAL_SESSION_STATUSES.has(row.status)) {
          if (appealInFlight) {
            logger.warn(
              `[GateItemVerifier] session ${sessionId.slice(0, 8)} concluded without answering its gate-verify appeal`,
            );
            teardown(applyContracts(appealFallback!));
            return;
          }
          if (row.status === 'error' || row.status === 'killed') {
            teardown(
              applyContracts({
                disposition: 'needs-setup',
                evidence: {
                  reason: `verification session ended ${row.status}`,
                  sessionId,
                },
              }),
            );
            return;
          }
          // 'done' with no gate_verify_disposition event yet — give the
          // in-flight event handler one more tick before abstaining, since
          // the disposition is parsed at the same turn boundary the status
          // flips on.
          logger.warn(
            `[GateItemVerifier] session ${sessionId.slice(0, 8)} concluded with no gate_verify report`,
          );
          teardown(
            applyContracts({
              disposition: 'needs-setup',
              evidence: {
                reason: 'no gate_verify report on conclusion',
                sessionId,
              },
            }),
          );
        }
      }, this.pollIntervalMs);

      handles.budget = setTimeout(() => {
        if (appealInFlight) {
          logger.warn(
            `[GateItemVerifier] session ${sessionId.slice(0, 8)} exceeded budget while its gate-verify appeal was outstanding`,
          );
          teardown(applyContracts(appealFallback!));
          return;
        }
        teardown(
          applyContracts({
            disposition: 'needs-setup',
            evidence: { reason: 'verification budget exceeded', sessionId },
          }),
        );
      }, this.budgetMs);

      if (preCaptured) {
        handleReport(toResult(preCaptured));
      }
    });
  }
}
