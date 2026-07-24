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
import type { GateItem } from './gateStore';
import type {
  GateItemVerifier,
  GateVerificationResult,
} from './gateReconciler';

const TERMINAL_SESSION_STATUSES = new Set(['done', 'error', 'killed']);

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
      '`sqlite3` or a direct filesystem/DB path: the live DB sits outside this ' +
      "sandbox and neither reaches it. For any other read your base tools don't " +
      'cover, stage a `session.requestCapability` intent naming that exact read ' +
      'and end the turn — an operator grant resumes you with it. If that is not ' +
      'practical for a bounded one-shot investigation, report `needs-setup` and ' +
      'name the missing capability. Never fabricate a pass/fail to route around ' +
      'a permission denial — a blocked read is grounds for needs-setup, not for ' +
      'guessing.',
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
        ]),
    `Report your finding by calling the \`${orchestratorMcpToolName('gate.verify')}\` tool ` +
      'exactly once, as your final action — never a chat JSON block, which is ' +
      'not delivered anywhere. `reclassify` is optional — omit it unless you ' +
      'are proposing a self-correction as described above:',
    '',
    '```json',
    `{"gateItemId": "${item.id}", "disposition": "pass"|"fail"|"needs-setup", "evidence": {"basis": "operational"|"source", "...": "..."}, "reclassify": {"to": "Human-Observation"|"needs-triage", "reason": "..."}}`,
    '```',
  ].join('\n');
}

/**
 * True when a `pass` result's evidence claims to be grounded in
 * operational/runtime observation rather than source-code reading alone.
 * Exported for testing.
 */
export function hasOperationalEvidence(evidence: unknown): boolean {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return false;
  }
  const basis = (evidence as Record<string, unknown>).basis;
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
  if (!evidence || typeof evidence !== 'object') return false;
  const tokens = tokenize(JSON.stringify(evidence));
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
  if (!evidence || typeof evidence !== 'object') return null;
  try {
    return JSON.stringify(evidence).toLowerCase();
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

    const result = await this.awaitDisposition(sessionId, preCaptured);
    return enforcePassEvidenceContract(result);
  }

  private awaitDisposition(
    sessionId: string,
    preCaptured?: GateVerifyDispositionPayload,
  ): Promise<GateVerificationResult> {
    return new Promise((resolve) => {
      let settled = false;
      const handles: {
        poll?: ReturnType<typeof setInterval>;
        budget?: ReturnType<typeof setTimeout>;
      } = {};
      const finish = (result: GateVerificationResult) => {
        if (settled) return;
        settled = true;
        if (handles.poll) clearInterval(handles.poll);
        if (handles.budget) clearTimeout(handles.budget);
        this.sessionManager.off('gate_verify_disposition', onDisposition);
        // The disposition has now been consumed by the reconciler's caller —
        // this one-shot session has no resume purpose from here on (a
        // re-verify dispatches a fresh session), so archive it rather than
        // let it linger. Skip sessions already terminal (error/killed —
        // AgentSession owns those transitions) or already archived by the
        // session's own clean-exit path.
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
        }
        resolve(result);
      };

      const onDisposition = (payload: GateVerifyDispositionPayload) => {
        if (payload.sessionId !== sessionId) return;
        finish({
          disposition: payload.disposition.disposition,
          evidence: payload.disposition.evidence ?? { sessionId },
          reclassify: payload.disposition.reclassify,
        });
      };

      if (preCaptured) {
        finish({
          disposition: preCaptured.disposition.disposition,
          evidence: preCaptured.disposition.evidence ?? { sessionId },
          reclassify: preCaptured.disposition.reclassify,
        });
        return;
      }

      this.sessionManager.on('gate_verify_disposition', onDisposition);

      handles.poll = setInterval(() => {
        const row = getSession(sessionId);
        if (row && TERMINAL_SESSION_STATUSES.has(row.status)) {
          if (row.status === 'error' || row.status === 'killed') {
            finish({
              disposition: 'needs-setup',
              evidence: {
                reason: `verification session ended ${row.status}`,
                sessionId,
              },
            });
            return;
          }
          // 'done' with no gate_verify_disposition event yet — give the
          // in-flight event handler one more tick before abstaining, since
          // the disposition is parsed at the same turn boundary the status
          // flips on.
          logger.warn(
            `[GateItemVerifier] session ${sessionId.slice(0, 8)} concluded with no gate_verify report`,
          );
          finish({
            disposition: 'needs-setup',
            evidence: {
              reason: 'no gate_verify report on conclusion',
              sessionId,
            },
          });
        }
      }, this.pollIntervalMs);

      handles.budget = setTimeout(() => {
        finish({
          disposition: 'needs-setup',
          evidence: { reason: 'verification budget exceeded', sessionId },
        });
      }, this.budgetMs);
    });
  }
}
