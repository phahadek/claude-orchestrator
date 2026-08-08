import { logger } from '../logger';
import { getProjectById } from '../config';
import {
  getSession,
  hasActiveCapabilityRequestForSession,
  markSessionDone,
  TERMINAL_SESSION_STATUSES,
} from '../db/queries';
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
export function buildGateVerifyProcedure(item: GateItem): string {
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
      'budget, or abstain. You hold no general write authority — no ' +
      'staging of task/arch/gate/seed writes, no commits, no multi-step ' +
      'operational change of any kind (the one narrow exception below ' +
      'aside) — and never call a gate-write API: you have no gate-write ' +
      'authority; the backend is the only writer of gate state, and your ' +
      '`gate.verify` report stages a proposed disposition for a human to ' +
      'approve or push back on, never a command that writes it directly. ' +
      'Auto-pass is never inferred by this session or by any backend ' +
      'heuristic — report clear, direct evidence and let the operator ' +
      'decide; if you cannot conclusively determine pass or fail, report ' +
      'needs-setup — abstain rather than guess.',
    '',
    '**The one narrow write exception.** If settling this item requires ' +
      'an operational trace that does not exist yet — the described ' +
      'behavior has never run, so there is nothing in audit_log/' +
      'session_events/live DB-API state to cite — you may request exactly ' +
      'one atomic, instrumental write strictly to produce the trace the ' +
      "item's described behavior would leave (e.g. seeding one row, " +
      'triggering one event) — never a multi-step or open-ended action. ' +
      'It is a single Bash ' +
      'command prefix or one named MCP write verb, requested the same way ' +
      'as any other capability (see "Capabilities" above): call ' +
      `\`${orchestratorMcpToolName('session.requestCapability')}\` with ` +
      '`{"payload":{"capability":"<one Bash command prefix or one named ' +
      'MCP write verb>","plan":"seed/trigger exactly this one row/event, ' +
      'then re-read the resulting trace and report gate.verify",' +
      '"evidence":"<why no existing trace covers this item>"}}`. Out of ' +
      'scope for this exception, with no exceptions of their own: ' +
      'reconcile-and-capture, any `ops_journal` transition, any other ' +
      'multi-step operational change, and any gate-write call — the write ' +
      'must be one atomic action that produces the closing trace ' +
      'directly, never the start of a longer procedure. The write is ' +
      'instrumental only and never itself the verdict — the same ' +
      '`gate.verify` pass/fail/needs-setup report is the only gate-facing ' +
      'output, and the backend remains the sole writer of gate state. ' +
      'Abstain remains the default: request this write only once the ' +
      'single closing action that would produce the trace is already ' +
      'identified — genuine ambiguity, or a need for more than one step, ' +
      'still routes to `needs-setup` rather than a speculative request.',
    '',
    'This session is responsible for asking for what it needs: nothing beyond ' +
      'its base read/stage profile is ever speculatively handed to it. If ' +
      "settling this item genuinely requires reading this orchestrator's own " +
      "runtime record (session_events/audit_log for a session you're verifying), " +
      'request the own-record read (see "Capabilities" above — ' +
      '`read:session-record:<target-session-id>`), not a Bash prefix like ' +
      '`sqlite3` or a direct filesystem/DB path — once granted, call the ' +
      `\`${orchestratorMcpToolName('session.getRecord')}\` tool with ` +
      '`{"targetSessionId":"<target-session-id>"}` to read it. For a ' +
      "project's broader audit_log (not scoped to one session), request " +
      '`read:audit-log:<project-id>` instead, then call the ' +
      `\`${orchestratorMcpToolName('auditLog.query')}\` tool with ` +
      '`{"projectId":"<project-id>"}`. This is a tool-set boundary, ' +
      'not a location one: this session spawns with broad filesystem access ' +
      "(it can read the orchestrator checkout and the box's local files), but " +
      'it holds no allow-listed client for the live SQLite file and no device ' +
      "auth for the orchestrator's API — so session_events/audit_log for a " +
      'specific session stay reachable only through the brokered read, not a ' +
      "direct file or DB path. For any other read your base tools don't " +
      'cover, stage a `session.requestCapability` intent naming that exact read ' +
      'and end the turn — an operator grant resumes you with it. Never fabricate ' +
      'a pass/fail to route around a permission denial — a blocked read is ' +
      'grounds for needs-setup, not for guessing.',
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
      'what operational trace is missing.',
    '',
    'Report your evidence as three required one-line fields — no free-' +
      'prose paragraph, no invented key of your own choosing (e.g. ' +
      '`conclusion`, `summary`, `basis`, `explanation`): `expected` (the ' +
      'behavior this item asserts), `found` (what the operational record ' +
      'actually shows, or that nothing was found), and `query` (the ' +
      'operational read you actually ran — tool + table/filter, e.g. ' +
      '"auditLog.query projectId=X action=Y"). `query` names the ' +
      'mechanism, not decoration: if all you did was grep source, you have ' +
      'no operational read to name there truthfully, which is itself a ' +
      'sign this should be `needs-setup`, not `pass`. A fourth field, ' +
      '`source` (a file:line reference), is admissible only when ' +
      '`disposition` is `fail`, to cite where the grounded error traces to ' +
      '— it is rejected by the tool on `pass` and `needs-setup` reports. ' +
      'These fields are the entire report; the operator reads exactly ' +
      '`expected` and `found` on the decision surface.',
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
            '(Read-Only/Prod-Mutating) so this session was ' +
            'dispatched to headlessly verify something it structurally ' +
            'cannot observe — propose the correct classification instead ' +
            'of forcing a pass/fail, or abstaining to a bare needs-setup ' +
            'that leaves the same mis-routing to recur next time. You may ' +
            'only propose `Human-Observation` (this is that case) or ' +
            '`needs-triage` (you cannot tell what tier actually fits and a ' +
            'human should decide) — never an auto-run tier. Include it as ' +
            'a `reclassify` field alongside your disposition (typically ' +
            '`needs-setup`, since you are also abstaining on this run); ' +
            'the backend applies it and re-routes the item once an ' +
            'operator approves your report, it does not change what you ' +
            'report for `disposition`.',
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
      'not delivered anywhere. This stages your report as a normal decision ' +
      'for a human operator: they may approve it as-is, or push back with ' +
      'feedback asking for more/different evidence, in which case you will ' +
      'be resumed for a normal turn to revise and report again — there is no ' +
      'limit on how many times this can happen. `reclassify` is required ' +
      'whenever you concluded the item cannot be settled from the ' +
      'operational record by construction (see above) — omit it only for a ' +
      'genuine pass/fail or a bounded-effort abstention that does not rest ' +
      'on structural unverifiability:',
    '',
    '```json',
    `{"gateItemId": "${item.id}", "disposition": "pass"|"fail"|"needs-setup", "evidence": {"expected": "...", "found": "...", "query": "..."}, "reclassify": {"to": "Human-Observation"|"needs-triage", "reason": "..."}}`,
    '```',
    '',
    'On a `fail`, `evidence` may also carry `source` (admissible only on fail):',
    '',
    '```json',
    '{"expected": "...", "found": "...", "query": "...", "source": "path/to/file.ts:123"}',
    '```',
  ].join('\n');
}

/**
 * The production GateItemVerifier: dispatches a gate-item-scoped read-only
 * investigation session (the 'ops' session kind — no worktree, no PR, no
 * grant-on-re-dispatch) and awaits its terminal gate_verify report.
 *
 * Bounded best-effort: abstains to needs-setup on budget exhaustion, a
 * crashed/killed session, or an unparseable/missing report. A session's
 * own reported disposition is never a final verdict here — it stages a
 * `gate.verify` intent (see AgentSession.recordGateVerifyDisposition) that
 * an operator disposes on the regular decision surface, exactly like any
 * other groom/design/ops session's staged intent. This class's job ends
 * the moment that report lands: it resolves `verify()` and leaves the
 * session live, parked awaiting disposition, rather than tearing it down.
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
    // instead of the session's actual report). We don't know sessionId yet,
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
        dispatchFailed: true,
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
   * Re-attaches an `awaitDisposition` listener to an already-dispatched,
   * still-live gate-verify session — no new session dispatch, since the
   * session found by boot reconciliation is already parked awaiting its
   * operator capability-request disposition and will resume on its own.
   * Recovers the case a backend restart loses: the in-memory listener that
   * would have routed the session's eventual `gate_verify_disposition`
   * report died with the old process, so without this the report fires
   * into a void and the item never leaves its non-terminal state.
   */
  reattach(item: GateItem, sessionId: string): Promise<GateVerificationResult> {
    return this.awaitDisposition(item, sessionId);
  }

  /**
   * Awaits the dispatched session's report. Two distinct outcomes:
   *  - The session reports (stages its `gate.verify` intent): resolves with
   *    `awaitingDisposition: true` and leaves the session alone — it stays
   *    live, parked awaiting the operator's disposition, exactly like any
   *    other ops session's staged intent. Nothing here writes gate state or
   *    tears the session down.
   *  - Dispatch/session failure (budget exceeded, crash, no report on
   *    conclusion): resolves with a plain `needs-setup` and reaps the
   *    session — there is no session-authored verdict here for an operator
   *    to review.
   */
  private awaitDisposition(
    item: GateItem,
    sessionId: string,
    preCaptured?: GateVerifyDispositionPayload,
  ): Promise<GateVerificationResult> {
    const sessionManager = this.sessionManager;
    return new Promise((resolve) => {
      let settled = false;
      const handles: {
        poll?: ReturnType<typeof setInterval>;
        budget?: ReturnType<typeof setTimeout>;
      } = {};

      const cleanup = () => {
        if (handles.poll) clearInterval(handles.poll);
        if (handles.budget) clearTimeout(handles.budget);
        sessionManager.off('gate_verify_disposition', onDisposition);
      };

      /** An infra/dispatch failure — nothing for an operator to review; reap the one-shot session. */
      const settleDispatchFailure = (result: GateVerificationResult) => {
        if (settled) return;
        settled = true;
        cleanup();
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
          sessionManager.archiveAndEndSession(sessionId);
        }
        resolve(result);
      };

      /** The session genuinely reported — leave it live and parked; the operator's disposition settles the item, not this verifier. */
      const settleStaged = (result: GateVerificationResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ...result, awaitingDisposition: true });
      };

      const toResult = (
        payload: GateVerifyDispositionPayload,
      ): GateVerificationResult => ({
        disposition: payload.disposition.disposition,
        evidence: payload.disposition.evidence ?? { sessionId },
        reclassify: payload.disposition.reclassify,
      });

      const onDisposition = (payload: GateVerifyDispositionPayload) => {
        if (payload.sessionId !== sessionId) return;
        settleStaged(toResult(payload));
      };

      sessionManager.on('gate_verify_disposition', onDisposition);

      handles.poll = setInterval(() => {
        const row = getSession(sessionId);
        if (row && TERMINAL_SESSION_STATUSES.has(row.status)) {
          if (row.status === 'error' || row.status === 'killed') {
            settleDispatchFailure({
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
          settleDispatchFailure({
            disposition: 'needs-setup',
            evidence: {
              reason: 'no gate_verify report on conclusion',
              sessionId,
            },
          });
        }
      }, this.pollIntervalMs);

      /**
       * The wall-clock budget, exempted while this session has a pending
       * `session.requestCapability` intent outstanding — a budget firing
       * mid-request would tear the session down (markSessionDone +
       * archiveAndEndSession) out from under a legitimately parked request,
       * racing the human review the request exists to wait for. While
       * parked, recheck on the poll cadence instead of failing; once the
       * request clears, re-arm a full, fresh budget window so the
       * verifier's own remaining investigative effort — not the parked
       * wait — is what gets governed from here on.
       */
      const onBudgetFire = () => {
        if (hasActiveCapabilityRequestForSession(sessionId)) {
          logger.info(
            `[GateItemVerifier] session ${sessionId.slice(0, 8)} exceeded budget while a capability request was outstanding — suspending budget until it clears`,
          );
          handles.budget = setTimeout(
            waitForCapabilityClear,
            this.pollIntervalMs,
          );
          return;
        }
        settleDispatchFailure({
          disposition: 'needs-setup',
          evidence: { reason: 'verification budget exceeded', sessionId },
        });
      };

      const waitForCapabilityClear = () => {
        if (hasActiveCapabilityRequestForSession(sessionId)) {
          handles.budget = setTimeout(
            waitForCapabilityClear,
            this.pollIntervalMs,
          );
          return;
        }
        handles.budget = setTimeout(onBudgetFire, this.budgetMs);
      };

      handles.budget = setTimeout(onBudgetFire, this.budgetMs);

      if (preCaptured) {
        settleStaged(toResult(preCaptured));
      }
    });
  }
}
