import { logger } from '../logger';
import { getProjectById } from '../config';
import { getSession, markSessionDone } from '../db/queries';
import type { SessionManager } from '../session/SessionManager';
import type { GateVerifyDispositionPayload } from '../session/AgentSession';
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
 * read-history doctrine. Rendered as the session's opsContext (the same
 * append-only injection seam an Ops(N)-launched session gets) — the session
 * never runs a vendored skill to assemble this itself.
 */
function buildGateVerifyContext(item: GateItem): string {
  const isHumanObservation = item.classification === 'Human-Observation';
  return [
    '## Gate Verification Context',
    '',
    'This is an individual, backend-dispatched read-only investigation ' +
      'session verifying a single Manual Verification Gate item. It is not ' +
      'auto-dispatched onto anything else — it exists to settle this one item.',
    '',
    '### Gate item',
    '',
    `- id: ${item.id}`,
    `- project: ${item.project}`,
    `- milestone: ${item.milestone}`,
    `- classification: ${item.classification}`,
    `- text: ${item.text}`,
    '',
    '### Procedure',
    '',
    'Read the operational record relevant to the item text above — audit_log, ' +
      'session_events, pull_requests, git history, and `gh` as needed — to ' +
      'determine whether the described behavior actually holds. This is a ' +
      'bounded best-effort read: settle within your time/turn budget, or ' +
      'abstain. Never stage, commit, or mutate anything, and never call a ' +
      'gate-write API — you have no gate-write authority; the backend is the ' +
      'only writer of gate state, and treats this report as evidence, not a ' +
      'command. Auto-pass only on clear, direct evidence; if you cannot ' +
      'conclusively determine pass or fail, report needs-setup — abstain ' +
      'rather than guess.',
    '',
    'Source is a legitimate input for orienting yourself, but a `pass` ' +
      'disposition must never rest on source-code reading alone — it must ' +
      'be grounded in operational/runtime evidence (audit_log entries, ' +
      'session_events, a merged PR, a deploy record, git history, `gh` ' +
      'output). If the strongest evidence you found is "the source code ' +
      'looks like it does X", that is not a pass — report needs-setup and ' +
      'explain what operational trace is missing. Set `evidence.basis` to ' +
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
      : []),
    'Report your finding by ending your final message with exactly one block ' +
      'of this shape (a bare JSON object is not enough — it must be the ' +
      '`gate_verify` key):',
    '',
    '```json',
    `{"gate_verify": {"gate_item_id": "${item.id}", "disposition": "pass"|"fail"|"needs-setup", "evidence": {"basis": "operational"|"source", "...": "..."}}}`,
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
 * The disposition contract's enforcement half of "no pass on source alone":
 * a `pass` disposition whose evidence doesn't claim operational grounding is
 * downgraded to `needs-setup` — the prompt asks nicely, this backstops it
 * regardless of what the session actually reported. Exported for testing.
 */
export function enforcePassEvidenceContract(
  result: GateVerificationResult,
): GateVerificationResult {
  if (result.disposition !== 'pass') return result;
  if (hasOperationalEvidence(result.evidence)) return result;
  return {
    disposition: 'needs-setup',
    evidence: {
      reason:
        'pass disposition lacked operational/runtime evidence — a source-only verdict cannot pass',
      reportedEvidence: result.evidence,
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

    let sessionId: string;
    try {
      sessionId = await this.sessionManager.start(item.id, project.contextUrl, {
        projectId: item.project,
        taskName: `Gate verify: ${item.text}`,
        sessionType: 'ops',
        taskKind: 'non_milestone',
        taskId: `gate-item:${item.id}`,
        opsContext: buildGateVerifyContext(item),
      });
    } catch (err) {
      return {
        disposition: 'needs-setup',
        evidence: {
          reason: 'failed to dispatch verification session',
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const result = await this.awaitDisposition(sessionId);
    return enforcePassEvidenceContract(result);
  }

  private awaitDisposition(sessionId: string): Promise<GateVerificationResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: GateVerificationResult) => {
        if (settled) return;
        settled = true;
        clearInterval(pollHandle);
        clearTimeout(budgetHandle);
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
        });
      };
      this.sessionManager.on('gate_verify_disposition', onDisposition);

      const pollHandle = setInterval(() => {
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

      const budgetHandle = setTimeout(() => {
        finish({
          disposition: 'needs-setup',
          evidence: { reason: 'verification budget exceeded', sessionId },
        });
      }, this.budgetMs);
    });
  }
}
