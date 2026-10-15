import { logger } from '../logger';
import { getProjectById } from '../config';
import {
  getSession,
  hasActiveCapabilityRequestForSession,
  markSessionDone,
  setSessionMetadata,
  setSessionTerminalCompletionReason,
  insertCompletingSignal,
  TERMINAL_SESSION_STATUSES,
} from '../db/queries';
import type { SessionManager } from '../session/SessionManager';
import type { GateVerifyDispositionPayload } from '../session/AgentSession';
import {
  renderAdHocReadCapability,
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

/** Wall-clock verify budget used both to bound a dispatch and, at read time, to compute a live session's elapsed/remaining for the fleet route — see routes/gateState.ts. */
export const DEFAULT_BUDGET_MS = 20 * 60_000;
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
/**
 * The timestamp the item's claim is actually about: the latest of its
 * source PRs' merge times (gate_item_source.added_at), or the item's own
 * updatedAt when it has no recorded sources. Reading current-state would
 * silently answer "is X true right now" instead of "was X true once this
 * merged" — a gate item dispatched for verification well after merge can
 * have its underlying session/PR/ops_journal/gate_item rows move on in the
 * meantime (a session redispatched, a PR's state changed post-merge), so
 * the operational-record reads below must pin to this cutoff, not now.
 */
function claimAsOf(item: GateItem): string {
  return item.sources.reduce(
    (latest, s) => (s.addedAt > latest ? s.addedAt : latest),
    item.updatedAt,
  );
}

export function buildGateVerifyProcedure(item: GateItem): string {
  const isHumanObservation = item.classification === 'Human-Observation';
  const asOf = claimAsOf(item);
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
    `- claim asOf: ${asOf}`,
    '',
    `**This item's claim is about ${asOf}** — the point this item's ` +
      'underlying change merged/deployed, not "right now". The record you ' +
      'read may have moved on since (a session redispatched, a PR ' +
      "reviewed again, an ops_journal entry re-transitioned) — that's a " +
      "later fact, not evidence about whether this item's claim held at " +
      'the time it describes. Wherever a tool below accepts an `asOf` ' +
      `parameter, pass \`asOf: "${asOf}"\` explicitly — omitting it reads ` +
      'current state, which answers a different question than the one ' +
      'this item asks. This applies to `gateSeed.getState`, ' +
      '`pullRequest.getByTaskId`, and `session.getRecord`; other tools ' +
      '(e.g. `auditLog.query`) are already point-in-time by construction ' +
      '(you filter their results by timestamp yourself). A field that ' +
      'comes back as `{"__unreconstructable": true, "reason": "..."}` has ' +
      'no historical record yet — treat it as unknown, never as if it were ' +
      'the current value.',
    '',
    ...renderProjectRecordAccess('ops', item.project),
    ...renderOpsCapabilities(item.project),
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
      '(`needs-setup` or `not-yet-triggerable`) or reclassify ' +
      '(`Human-Observation`) — never substitute a precondition or source ' +
      'reading for it.',
    '',
    '**Two abstains, not one — pick the one that actually fits.** ' +
      '`needs-setup` means a human must perform some real setup step before ' +
      'this item can be settled at all: a missing capability grant you were ' +
      'refused, a permission you cannot obtain, an identifier you searched ' +
      'for and could not find, or any other blocker a person has to clear. ' +
      '`not-yet-triggerable` means there is no blocker to clear — the ' +
      "scenario this item describes simply hasn't happened yet, or the data " +
      'it would produce a trace from does not exist yet, and the item just ' +
      'needs to be re-checked later once it has. Reporting `needs-setup` ' +
      'for a not-yet-occurred scenario is wrong: it removes the item from ' +
      'every future automated pull (nothing re-checks it), where ' +
      '`not-yet-triggerable` instead parks it for an automatic scheduled ' +
      'retry. Decide with two questions, in order. (1) Can the scenario ' +
      'occur at all without someone staging it? If it only happens when ' +
      'an operator does something — tell words: dispatch, revoke, seed, ' +
      'force, configure, commit-and-dispatch, set a ceiling on a scratch ' +
      'project — nothing will ever trigger it by itself, so re-checking ' +
      'is futile: report `needs-setup`, and make `evidence.found` name ' +
      'the exact step the operator must perform. (2) Only if it can ' +
      'occur on its own: will re-checking this later, with no human ' +
      'intervention, plausibly settle it? Yes means `not-yet-triggerable`; ' +
      'no means `needs-setup`.',
    '',
    '**A `not-yet-triggerable` absence claim must rest on a read that ' +
      'covered its whole window**, and `evidence.query` must state that ' +
      'coverage. Admissible: an `auditLog.query` with a recognized ' +
      '`eventType` (`eventTypeRecognized` true) whose `entries.length` ' +
      'equals `matchedCount`; a whole-table aggregate through the ' +
      "project's ad hoc read command (`SELECT … COUNT(*) … WHERE ts >= " +
      '<claim asOf>`); or a `sessionEvents.query` count. Not admissible: ' +
      'an unfiltered newest-200 sample (`auditLog.query` returns only the ' +
      'newest 200 matching rows), an `eventType` with ' +
      '`eventTypeRecognized=false` (a guessed name), or no read at all. If ' +
      'no admissible read is reachable, report plain `needs-setup` ' +
      '(bounded-effort abstention), never `not-yet-triggerable`.',
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
    ...renderAdHocReadCapability(item.project),
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
            'of forcing a pass/fail. `Human-Observation` is only for what a ' +
            'human must see with their own eyes: rendered UI, colour, ' +
            'layout, wrapping, or a visual read of a running page. Include ' +
            'it as a `reclassify` field alongside your disposition ' +
            '(typically `needs-setup`, since you are also abstaining on ' +
            'this run); the backend applies it and re-routes the item once ' +
            'an operator approves your report, it does not change what you ' +
            'report for `disposition`.',
          '',
          '`reclassify` to `needs-triage` is for item text that is ' +
            'unanswerable as written: it names a retired job, has no ' +
            'referent, or relies on a baseline that no longer exists.',
          '',
          'Do NOT reclassify just because no operational trace exists by ' +
            'construction — a live HTTP response, request latency, server ' +
            'log lines, a host-side command, or a transcript you can read ' +
            'yourself are not visual. Report a plain `needs-setup` with ' +
            'no `reclassify`, and make `evidence.found` name exactly what ' +
            'the operator must observe or run. A plain `needs-setup` ' +
            'auto-commits and stays blocking; a reclassify forces a manual ' +
            'operator decision (and, for `Human-Observation`, a second one ' +
            'for the mirrored item).',
          '',
        ]),
    `Report your finding by calling the \`${orchestratorMcpToolName('gate.verify')}\` tool ` +
      'exactly once, as your final action — never a chat JSON block, which is ' +
      'not delivered anywhere. This stages your report as a normal decision ' +
      'for a human operator: they may approve it as-is, or push back with ' +
      'feedback asking for more/different evidence, in which case you will ' +
      'be resumed for a normal turn to revise and report again — there is no ' +
      'limit on how many times this can happen. `reclassify` is optional ' +
      'and narrow (see above) — omit it for a pass/fail, for any ' +
      '`needs-setup` abstention, and for any `not-yet-triggerable`:',
    '',
    '```json',
    `{"gateItemId": "${item.id}", "disposition": "pass"|"fail"|"needs-setup"|"not-yet-triggerable", "evidence": {"expected": "...", "found": "...", "query": "..."}, "reclassify": {"to": "Human-Observation"|"needs-triage", "reason": "..."}}`,
    '```',
    '',
    'On a `fail`, `evidence` may also carry `source` (admissible only on fail):',
    '',
    '```json',
    '{"expected": "...", "found": "...", "query": "...", "source": "path/to/file.ts:123"}',
    '```',
    '',
    '### Reaching a `fail`: locate the root cause first',
    '',
    'A `fail` files a follow-on 💻 Code task, and a Code task that fixes a ' +
      'defect is filed only after the cause is located. A fail without a ' +
      'located cause is never reported — it is `needs-setup`. Three locks ' +
      '(from the task-writing standard, "Root cause, before a Code task is ' +
      'filed") must all be written:',
    '',
    '1. **The branch.** The file, the function, and the condition that ' +
      'produces the bad result.',
    '2. **The input that takes that branch.** A real row, or a real run, ' +
      'from the process that is running the code the task is filed ' +
      'against. A window that still contains a previous process or a ' +
      'previous deploy is not that input.',
    '3. **The fix that follows from that branch.** What the branch must do ' +
      'instead, and what it must still do for the input that is supposed ' +
      'to take it.',
    '',
    'These are not a cause, and are not enough to file: a count, a share, ' +
      'or a histogram of labels; the desired end state; a label the branch ' +
      'already produces on purpose for that input; a write the current ' +
      'code no longer contains (rows from an older process).',
    '',
    'On reaching a fail, and before staging, continue read-only:',
    '',
    '- Locate the cause in the project checkout (your cwd) with the read ' +
      'verbs you already hold (`git grep`, `git show <deployed-sha>:<file>`, ' +
      "`git log`, `git blame`, Read), against the project's deployed SHA, " +
      'not the checkout HEAD.',
    '- Tie the cause to a real row or run from the operational record.',
    '- Search the milestone board with `task_queryTasks` for an open task ' +
      'whose body already names the same cause. If one exists, report ' +
      '`proposedFix: {"existingTaskId": "<full task id>"}` and file nothing new.',
    '',
    'If you cannot write all three locks within budget, report ' +
      '`needs-setup` (never `fail`), with `evidence.found` keeping the ' +
      'observed failure prefixed `cause not located:`. Stage before the ' +
      "budget runs out: a budget-exceeded abstain loses this session's " +
      'evidence.',
    '',
    'A `fail` requires a top-level `proposedFix` (admissible only on fail), ' +
      'either a new-task payload or an existing task:',
    '',
    '```json',
    '{"proposedFix": {"title": "...", "cause": {"file": "path/to/file.ts", "line": 123, "condition": "..."}, "input": "...", "fix": "...", "filesAffected": ["path/to/file.ts", "path/to/new.test.ts *(new)*"], "automatedCriteria": ["..."]}}',
    '{"proposedFix": {"existingTaskId": "<full id of an open task on this milestone board>"}}',
    '```',
    '',
    '`title` is a real task title, not a restatement of the gate item text. ' +
      '`cause.file` and every `filesAffected` entry not marked `*(new)*` ' +
      'must be tracked files in the repo, and `existingTaskId` must be the ' +
      'full id of an open task on this milestone board: staging is ' +
      'rejected otherwise, with a message naming the offending value. The ' +
      'reconciler renders the full task body from this payload; this ' +
      'grants you no write authority.',
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

  async verify(
    item: GateItem,
    opts?: { unattended: boolean },
  ): Promise<GateVerificationResult> {
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
        gateVerifyUnattended: opts?.unattended ?? false,
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
    setSessionMetadata(sessionId, { gateVerifyUnattended: true });
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
    _item: GateItem,
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
          setSessionTerminalCompletionReason(
            sessionId,
            'gate_item_verifier_consumed',
          );
          // Dual-write bridge (see session/completingSignalRegistry.ts and
          // sessionStatusDeriver.ts) — purely additive ahead of any
          // read-side cutover; never gates or alters the writes above.
          insertCompletingSignal({
            session_id: sessionId,
            task_id: row.task_id ?? null,
            session_type: row.session_type,
            signal_class: 'staged_intent',
            signal_value: 'gate_item_verifier_consumed',
            recorded_at: Date.now(),
          });
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
        proposedFix: payload.disposition.proposedFix,
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
