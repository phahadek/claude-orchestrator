/**
 * Injected planning-procedure assembler — the single composable builder
 * behind a dispatched planning session's appended-prompt file, mirroring
 * buildOrchestratorClaudeMd's single-builder-with-branches pattern (see
 * `session/orchestrator-claudemd.ts`) but for the stage-then-human-apply
 * (groom/design) / drive-to-applied (ops) execution modes instead of the
 * code-dispatch one.
 *
 * Composition (three slots, always in this order):
 *
 *   1. Skeleton (written once, shared by every workflow): session lifecycle
 *      (stage-only for groom/design, write-capable drive-to-applied for ops),
 *      the transport, and the structured output contract (staged intents +
 *      the decision-proposal annotation).
 *   2. Per-kind procedure core: `procedureCore.ts`'s principles + ordered
 *      steps for the workflow — the same canonical module the interactive
 *      SKILL.md files compose, so an injected session and an interactive one
 *      never drift on the underlying procedure.
 *   3. Per-type digest: a constrained section set drawn from that workflow's
 *      loader (groomLoad / designLoad / opsLoad) — never the full loader
 *      result. Milestone-wide or rare context (the arch store, the ops
 *      master context pages, neighbour boards) is deliberately left out —
 *      a dispatched session fetches it on demand through the loader's GET
 *      route instead of carrying it in the initial prompt.
 *
 * Delivery: the caller (the /api/planning/launch dispatch route) resolves
 * the digest via `deriveGroomDigestSlice` / `deriveDesignDigestSlice` /
 * `deriveOpsDigestSlice`, calls `assemblePlanningProcedure`, and writes the
 * result to the session's appended-prompt file (`writeSystemPromptFile` in
 * `session/SessionManager.ts`) — the same `--append-system-prompt-file`
 * delivery a code-dispatch session uses for `buildOrchestratorClaudeMd`, but
 * carrying this module's output instead. Planning sessions never receive
 * `buildOrchestratorClaudeMd` content (see `SessionManager.completeStart`'s
 * `injectedProcedureContent` branch).
 */

import {
  SKILL_LABELS,
  principlesFor,
  renderPrinciple,
  stepsFor,
  stepSummaryFor,
  type SkillId,
} from './procedureCore';
import type { GroomLoadResult } from '../groom/groomLoad';
import type { TaskRegions } from '../groom/codeWorklist';
import type { TaskDependencyCandidates } from '../orchestration/milestoneDependencyGraph';
import type { ReadinessViolation } from '../tasks/readinessGate';
import type { TypeCheckResult } from '../groom/typeCheck';
import type { DesignLoadResult } from '../design/designLoad';
import type { OpsLoadResult, OpsTaskEntry } from '../ops/opsLoad';
import type { OpsJournalEntry } from '../ops/opsJournal';

export type PlanningWorkflow = SkillId;

/**
 * Maps workflow → the loader that produces its digest, for reference by
 * the dispatch route (which loader to call before assembling). Kept as
 * plain data (not function references) so this module never has to import
 * three loaders' worth of Notion/DB dependencies just to describe them.
 */
export const WORKFLOW_LOADERS: Record<PlanningWorkflow, string> = {
  groom: 'groom/groomLoad.ts#loadGroomContext',
  design: 'design/designLoad.ts#loadDesignContext',
  ops: 'ops/opsLoad.ts#loadOpsContext',
};

// ─── per-type digest slices (Q3: a constrained section set, not the loader's
// full milestone-wide result) ───────────────────────────────────────────────

/**
 * Orientation grafted into the digest when a task's own declared scope
 * resolves empty — the milestone-wide code-worklist packages and sibling
 * target tasks' resolved regions, already computed/cached in the bundle
 * (`GroomLoadResult`), so a session with nothing of its own still gets a
 * starting point for its one bounded exploration pass instead of a bare
 * `(none)`. Empty on a fresh milestone with no other resolved regions
 * either — callers must degrade gracefully, not treat it as an error.
 */
interface GroomOrientation {
  /** Every package the milestone's target tasks collectively declare. */
  milestonePackages: string[];
  /** Other target tasks' own resolved regions, for "what does a sibling task touch" context. */
  siblingRegions: {
    taskId: string;
    title: string;
    packages: string[];
    files: string[];
  }[];
}

export interface GroomDigestSlice {
  task: {
    id: string;
    title: string;
    status: string;
    type: string;
    url: string;
  };
  sizeCheckSeed: { files: number; loc_method: 'estimated' };
  typeCheck: TypeCheckResult;
  readinessViolations: ReadinessViolation[];
  bindingConstraints: string[];
  dependencyCandidates: TaskDependencyCandidates | null;
  /** This task's declared scope, resolved into package/file regions — the code it touches. */
  regions: TaskRegions;
  /** The task's full markdown body, verbatim. */
  body: string;
  /** Milestone-wide orientation, consulted by the digest only when `regions` resolves empty. */
  orientation: GroomOrientation;
}

export interface DesignDigestSlice {
  task: {
    id: string;
    title: string;
    status: string;
    type: string;
    url: string;
  };
  markdown: string;
  openQuestions: DesignLoadResult['openQuestions'];
  archUnits: DesignLoadResult['archUnits'];
  unresolvedPageRefs: DesignLoadResult['unresolvedPageRefs'];
  /** Whether milestone-wide code-map grounding is cached — the grounding
   *  itself is rare/large context, fetched on demand rather than carried here. */
  hasCodeMapGrounding: boolean;
}

export interface OpsDigestSlice {
  task: OpsTaskEntry;
  journalEntry: OpsJournalEntry | null;
}

export type PlanningDigest =
  | { workflow: 'groom'; data: GroomDigestSlice }
  | { workflow: 'design'; data: DesignDigestSlice }
  | { workflow: 'ops'; data: OpsDigestSlice };

const normId = (id: string) => id.replace(/-/g, '').toLowerCase();

/**
 * Thrown by `deriveGroomDigestSlice` when the dispatched task isn't in the
 * loaded worklist. Distinct from a generic Error so `OpsSessionLauncher` can
 * tell "worklist reconciliation still didn't find it" apart from any other
 * assembly failure, and surface a specific reason instead of the session
 * launching and later hitting SessionManager's generic no-procedure fail-loud.
 */
export class GroomWorklistTaskNotFoundError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly reason: string,
    milestone?: string,
  ) {
    super(
      `task ${taskId} not present in the ${milestone ? `${milestone} ` : ''}groom worklist — ${reason}`,
    );
    this.name = 'GroomWorklistTaskNotFoundError';
  }
}

/** Narrow a full `loadGroomContext` result to the one target task's validation slice. */
export function deriveGroomDigestSlice(
  result: GroomLoadResult,
  taskId: string,
  milestone?: string,
): GroomDigestSlice {
  const doc = result.targetTasks.find((t) => normId(t.id) === normId(taskId));
  if (!doc) {
    const boardRow = result.board.find((r) => normId(r.id) === normId(taskId));
    const reason = boardRow
      ? `task status is "${boardRow.status}" — excluded as Done/Deferred, not groomable`
      : 'task is not present on the milestone board — worklist may be stale or the task is on a different milestone/board';
    throw new GroomWorklistTaskNotFoundError(taskId, reason, milestone);
  }
  const dependencyCandidates =
    result.dependencyCandidates.find(
      (c) => normId(c.taskId) === normId(taskId),
    ) ?? null;
  const orientation: GroomOrientation = {
    milestonePackages: [...result.codeWorklist.keys()].sort(),
    siblingRegions: result.targetTasks
      .filter((t) => normId(t.id) !== normId(taskId))
      .filter((t) => t.regions.packages.length || t.regions.files.length)
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        packages: t.regions.packages,
        files: t.regions.files,
      })),
  };
  return {
    task: {
      id: doc.id,
      title: doc.title,
      status: doc.status,
      type: doc.type,
      url: doc.url,
    },
    sizeCheckSeed: doc.sizeCheckSeed,
    typeCheck: doc.typeCheck,
    readinessViolations: doc.readinessViolations,
    bindingConstraints: doc.bindingConstraints,
    dependencyCandidates,
    regions: doc.regions,
    body: doc.rawMarkdown,
    orientation,
  };
}

/** `loadDesignContext` already resolves a single target task — just narrow the fields carried forward. */
export function deriveDesignDigestSlice(
  result: DesignLoadResult,
): DesignDigestSlice {
  return {
    task: result.task,
    markdown: result.markdown,
    openQuestions: result.openQuestions,
    archUnits: result.archUnits,
    unresolvedPageRefs: result.unresolvedPageRefs,
    hasCodeMapGrounding: Object.keys(result.codeMapGrounding).length > 0,
  };
}

/** Narrow a full `loadOpsContext` result to the one target task's journal slice. */
export function deriveOpsDigestSlice(
  result: OpsLoadResult,
  taskId: string,
  journalEntry: OpsJournalEntry | null,
): OpsDigestSlice {
  const allTasks = [
    ...result.worklist.executable,
    ...result.worklist.dep_blocked,
    ...result.worklist.needs_grooming,
    ...result.worklist.closed_not_done,
  ];
  const task = allTasks.find((t) => normId(t.id) === normId(taskId));
  if (!task) {
    throw new Error(
      `procedureAssembler: task ${taskId} not found in ops worklist`,
    );
  }
  return { task, journalEntry };
}

// ─── skeleton (written once) ───────────────────────────────────────────────

/** Staged-intent kinds relevant to an injected planning session, mirrored from
 *  `routes/stagedIntents.ts`'s `KNOWN_INTENT_KINDS` (not imported directly —
 *  that module pulls in Express/DB wiring this composer has no business
 *  depending on). `procedureAssembler.test.ts` asserts this stays a subset. */
const PLANNING_INTENT_KINDS: Record<PlanningWorkflow, readonly string[]> = {
  groom: [
    'task.setStatus',
    'task.setProperties',
    'task.setDependsOn',
    'gate.accrete',
    'seed.stage',
    'task.create',
  ],
  design: [
    'task.updateBody',
    'task.setProperties',
    'task.setStatus',
    'seed.stage',
    'task.create',
  ],
  ops: [
    'journal.setState',
    'task.setStatus',
    'session.requestCapability',
    'task.create',
  ],
};

/**
 * One concrete example `stage-task-intent.mjs` payload per known intent
 * kind — placeholders (`<task-id>`, `<milestone-id>`, ...) stand in for
 * real values. Rendered next to each allowed kind in the Transport section
 * so a dispatched session has the exact invocation shape in hand instead of
 * grepping `KNOWN_INTENT_KINDS` / `staged-intents-client.mjs` usage
 * comments to reconstruct a payload shape by trial and error.
 */
const INTENT_KIND_EXAMPLE_PAYLOADS: Record<string, string> = {
  'task.setStatus': '{"taskId":"<task-id>","status":"Ready"}',
  'task.setProperties': '{"taskId":"<task-id>","properties":{"priority":"P1"}}',
  'task.setDependsOn': '{"taskId":"<task-id>","dependsOn":["<other-task-id>"]}',
  'gate.accrete':
    '{"project":"<project-id>","taskId":"<task-id>","title":"<title>",' +
    '"milestone":"<milestone-id>","classification":"Read-Only",' +
    '"items":[{"text":"<gate item text>"}]}',
  'seed.stage':
    '{"project":"<project-id>","taskId":"<task-id>","title":"<title>",' +
    '"milestone":"<milestone-id>","decision":"seeds",' +
    '"seeds":[{"spec":"<config-seed spec>"}]}',
  'task.create':
    '{"title":"<title>","type":"💻 Code","milestone":"<milestone-id>",' +
    '"body":"<task body markdown>"}',
  'task.updateBody': '{"taskId":"<task-id>","body":"<full markdown>"}',
  'journal.setState':
    '{"taskId":"<task-id>","state":"staged-proposal",' +
    '"fields":{"findingOrProposal":"<finding or proposal>"}}',
  'session.requestCapability':
    '{"capability":"<one Bash command prefix, one named MCP write verb, or ' +
    "read:session-record:<target-session-id> for the orchestrator's own " +
    'session_events/audit_log>","reason":"<why this session needs it>"}',
};

/** Render one `node stage-task-intent.mjs <kind> '<payload>'` line per allowed kind. */
function renderIntentKindInvocations(kinds: readonly string[]): string[] {
  return kinds.map((kind) => {
    const payload = INTENT_KIND_EXAMPLE_PAYLOADS[kind];
    return payload
      ? `- \`node ~/.claude/scripts/stage-task-intent.mjs ${kind} '${payload}'\``
      : `- \`node ~/.claude/scripts/stage-task-intent.mjs ${kind} '<json-payload>'\``;
  });
}

/**
 * Up-front capability inventory for a dispatched ops session — what it can do
 * out of the box, how it earns more, and what no grant can ever unlock. Stated
 * before the session does anything, so it stops probing tools by trial-and-
 * error and hitting denials. Mirrors the real allowlist wiring in
 * `session/orchestrator-config.ts` (`OPS_ALLOWED_TOOLS`, `getSessionAllowedTools`)
 * and the grant mechanism in `routes/stagedIntents.ts` (`session.requestCapability`
 * → `SessionManager.grantCapability`) and `GRANT_DENYLIST_PATTERNS` — kept in
 * prose here rather than imported, since this composer has no business
 * depending on the Express/DB wiring those modules pull in.
 *
 * Exported so the gate-verify dispatch path (`gate/gateItemVerifier.ts`),
 * which builds its own injected context outside this assembler, can compose
 * the same ask-permission guidance instead of restating it — a dispatched
 * gate-verify session is an `ops`-typed session and gets the same base
 * profile and the same `session.requestCapability` path.
 */
export function renderOpsCapabilities(): string[] {
  return [
    '## Capabilities',
    '',
    'This session starts with a fixed base tool set and nothing more: read-only ' +
      'Bash (ls, cat, grep, find, git log/diff/show/status/blame/ls-files/rev-parse, ' +
      "etc.), read-only Notion MCP tools, and this project's audited live-data read " +
      'surface (analyst/alarm/read-only-DB MCP tools, where configured). No write, no ' +
      'Write/Edit tool, and no prod-mutating command is granted by default — do not ' +
      'probe for one.',
    '',
    'If the task genuinely needs a write or a prod-mutating command this session ' +
      'does not have, request it: stage a `session.requestCapability` intent naming ' +
      'the exact capability (one Bash command prefix or one named MCP write verb — ' +
      'never a category). An operator reviews it; on approval the capability is ' +
      'durably granted to this session alone and it is re-dispatched with that tool ' +
      "available. On rejection or pushback, the session resumes with the operator's " +
      'feedback instead.',
    '',
    "To verify by value against this orchestrator's own runtime state (e.g. " +
      "confirming a prior session's turn actually ran, or reading its staged/audit " +
      'trail), request the one grantable own-record read instead of a Bash prefix: ' +
      'stage `session.requestCapability` with ' +
      '`capability: "read:session-record:<target-session-id>"` — never ' +
      "`Bash(sqlite3 ...)` or similar, which cannot reach the orchestrator's DB from " +
      'this sandbox and cannot authenticate to its device-authed API. On approval, ' +
      'read the result with `node ~/.claude/scripts/read-session-record.mjs ' +
      "<target-session-id>` — it returns that session's session_events and " +
      'audit_log, brokered by the orchestrator itself since this session holds no ' +
      'device auth. Read-only: there is no write form of this capability.',
    '',
    'Some things are never grantable this way, no matter what an operator approves: ' +
      'anything that reaches the resolved / ✅ Done / task-intent-apply transition ' +
      '(that stays device-auth/operator-only — see "Granted writes are idempotent ' +
      'and resumable" below), and the Write/Edit tools — authoring or rewriting a ' +
      'file is always a Code task, not something a capability grant hands to ops ' +
      '(see "Dispatch-eligibility boundary" below).',
    '',
    'Never create a PR, and never author or land code yourself, no matter how small ' +
      'the change looks: this session has no worktree or branch (see "Session ' +
      'Lifecycle" above), and a code change is categorically a 💻 Code task. If ' +
      'driving the operational change to `applied-pending-confirm` turns out to need ' +
      'one, stage a `task.create` intent carrying the spec instead of opening a PR — ' +
      'then continue driving the rest of the change, or park on it if the whole ' +
      'thing is now blocked on that Code task landing.',
    '',
  ];
}

function renderSkeleton(
  workflow: PlanningWorkflow,
  taskName: string,
  taskUrl: string,
  milestoneId: string,
  projectId: string,
): string {
  const label = SKILL_LABELS[workflow];
  const kinds = PLANNING_INTENT_KINDS[workflow];
  const lifecycle =
    workflow === 'ops'
      ? `This is an injected, non-interactive ${label} session for a single target task ` +
        `(${taskName} — ${taskUrl}). There is no worktree and no feature branch, and this ` +
        'session never creates a PR — the worktree-branch-PR invariant holds for ops too ' +
        '(see "Capabilities" below for what a code change routes through instead). Unlike ' +
        'groom/design, this session is write-capable, earning capabilities on request, and ' +
        'its job is to drive the operational change itself to completion, not to stage a ' +
        'proposal and hand execution back. The terminal state is the ops_journal ' +
        'reaching `applied-pending-confirm` — the change actually applied, reconciled, and ' +
        'its evidence captured — not a staged proposal parked for someone else to execute. ' +
        'End the turn only when genuinely blocked on an operator decision (a pending ' +
        'capability request, or a step only a human can perform, like secret provisioning) ' +
        '— never at a "proposal staged" point when there is more of the change left to ' +
        'drive; the only operator/device-auth-only step is the final ' +
        '`applied-pending-confirm` → `resolved` confirmation, not anything before it.'
      : `This is an injected, non-interactive ${label} session for a single target task ` +
        `(${taskName} — ${taskUrl}). There is no worktree and no feature branch — this ` +
        'session runs read-only/stage-only against the project checkout. When the ' +
        'procedure below reaches a natural stopping point (every open item presented ' +
        'and either staged or explicitly deferred), end the turn instead of waiting — ' +
        'the session parks into idle rather than scraping for a PR.';
  return [
    '## Session Lifecycle',
    '',
    lifecycle,
    '',
    ...(workflow === 'ops' ? renderOpsCapabilities() : []),
    '## Transport',
    '',
    'Do not call the task backend, Notion, or any raw HTTP client directly. Every ' +
      'write is a staged intent submitted through the sanctioned session-side CLI ' +
      "client (POST /api/task-intents, authenticated by this session's scoped stage " +
      'credential). That endpoint only ever stages — applying a staged intent is a ' +
      'separate human/device-authenticated action this session cannot reach.',
    '',
    `- Milestone: \`${milestoneId}\``,
    `- Project: \`${projectId}\``,
    '- Credential: the scoped stage-only token in the `ORCHESTRATOR_STAGE_TOKEN` ' +
      'env var (already set in this process — never printed, never re-derived; ' +
      'this is the only credential this session holds unless the credential ' +
      'list below says otherwise).',
    `- Allowed intent kinds for this session: ${kinds.join(', ')}. Staging any ` +
      'other kind is rejected server-side — do not grep `KNOWN_INTENT_KINDS` to ' +
      'check; this list is already the authoritative subset for this session type.',
    '- Client invocation, one example per allowed kind:',
    ...renderIntentKindInvocations(kinds),
    ...(workflow === 'ops'
      ? [
          '- Additional ops-only credential: `ORCHESTRATOR_OPS_JOURNAL_TOKEN` — a ' +
            'second, session-scoped token set only for this session type, distinct ' +
            'from `ORCHESTRATOR_STAGE_TOKEN` above. It authorizes ' +
            '`POST /api/ops-journal/:taskId/state` directly (loopback-only, ' +
            "restricted to this session's own task and to the staging transitions " +
            '— never `-> resolved`), for driving the ops_journal itself while a ' +
            'change is in progress, separately from staging a `journal.setState` ' +
            'intent through `stage-task-intent.mjs` above.',
        ]
      : []),
    '',
    '## Structured Output Contract',
    '',
    `Stage findings as one of: ${kinds.join(', ')}. Every staged intent that ` +
      'proposes resolving an explicit open question, decision, or gate item must ' +
      'carry a `decisionProposal` annotation — a short human-readable string naming ' +
      'the question it resolves and the recommended answer — so the reviewing human ' +
      'sees the proposal instead of a bare payload diff. Batch multiple independent ' +
      'findings under a shared `groupId` when they were derived together; never ' +
      "silently apply — staging is the full extent of this session's authority." +
      (workflow === 'groom'
        ? ' Promoting to Ready is not the only outcome available: if the task should ' +
          'not move forward — it is out of scope, superseded, no longer worth doing, ' +
          'or better revisited later — propose a discard/defer instead by staging ' +
          '`task.setStatus` → `Deferred`, with a `decisionProposal` naming why ' +
          'discard/defer is recommended over grooming it to Ready. This is a ' +
          'first-class alternative outcome, not a fallback for a session that got stuck.\n\n' +
          'A `task.setStatus` → `Ready` proposal is structured, not free prose: carry ' +
          "the `/groom` skill's defined proposal format (`skills/groom/reference/" +
          'presentation.md` § "The 4-point summary") as a `groomProposal` object — ' +
          '`{achieves, openQuestions, automatedTests, manualVerification, ' +
          'operationalSeed}`, every field a string (write `"None."` for a genuinely ' +
          'clean field, never omit it) — instead of packing the same judgment into a ' +
          'single `decisionProposal` paragraph. This is the same contract the ' +
          'interactive `/groom` skill presents for human sign-off; a dispatched ' +
          'session emits it as data so the reviewing human sees fields, not a prose ' +
          "summary to re-parse. Pass it as the invocation's 5th argument: " +
          '`node ~/.claude/scripts/stage-task-intent.mjs task.setStatus ' +
          '\'{"taskId":"<task-id>","status":"Ready"}\' <groupId> "" ' +
          '\'{"achieves":"...","openQuestions":"None.","automatedTests":"...",' +
          '"manualVerification":"None.","operationalSeed":"None."}\'` ' +
          '(the 4th argument, `decisionProposal`, is left empty here — `groomProposal` ' +
          'replaces it for this kind; `decisionProposal` still applies to a ' +
          '`Deferred` proposal, which has no achieves/tests to report).\n\n' +
          'A `task.setStatus` → `Ready` proposal also carries a `groomingGate` object ' +
          'on the same payload, alongside `taskId`/`status` — every field below is ' +
          'required (checkGroomingPromotionGate in `groomGate.ts` blocks the Ready ' +
          'flip at commit time on anything missing, and the block is surfaced back to ' +
          'you at stage time, not silently dropped): `size_check` ' +
          '(`{"decision": "no_split"|"split_now"|"unsplittable"|"n/a"}` — Code/Tooling ' +
          'tasks default to "no_split" under the 500-LoC-estimated threshold, "n/a" is ' +
          'for Design/Planning types only), `type_check` (`{"decision": "none"|' +
          '"flagged"|"n/a"}`, plus `signals` naming the matched phrases when ' +
          '"flagged"), `type` (the task\'s display-format Type, e.g. `"💻 Code"`), ' +
          '`regions` (`{"packages": [...], "files": [...]}` — this task\'s resolved ' +
          "code regions, the same shape as the digest's Code regions section), " +
          '`constraintsDispositioned` (a map of binding-constraint id → ' +
          '`{"disposition": "complies"}` | `{"disposition": "n/a", "why": "..."}` | ' +
          '`{"disposition": "conflict_route", "routedTaskId": "<design-task-id>"}` — ' +
          "one entry per id in the digest's Binding constraints list), " +
          '`filesPathsEntries` (one `{"raw": "<list item text>", "isNew": false, ' +
          '"existsInRepo": true}` per `## Files / paths affected` line — `isNew: ' +
          'true` for a `*(new)*`-marked not-yet-created path), and `dependsOnTasks` ' +
          '(one `{"id": "<task-id>", "type": "<type>", "status": "<status>"}` per ' +
          'declared Depends On edge — `[]` when there are none). A worked, ' +
          'field-complete example for a 💻 Code task with one binding constraint, ' +
          'one Files/paths entry, and no dependencies: ' +
          '`node ~/.claude/scripts/stage-task-intent.mjs task.setStatus ' +
          '\'{"taskId":"<task-id>","status":"Ready","groomingGate":{' +
          '"size_check":{"decision":"no_split"},' +
          '"type_check":{"decision":"none"},' +
          '"type":"💻 Code",' +
          '"regions":{"packages":["packages/backend"],"files":["packages/backend/src/foo.ts"]},' +
          '"constraintsDispositioned":{"constraint-a":{"disposition":"complies"}},' +
          '"filesPathsEntries":[{"raw":"packages/backend/src/foo.ts","isNew":false,"existsInRepo":true}],' +
          '"dependsOnTasks":[]}}\'` — omitting any one of these six `groomingGate` ' +
          'fields (even as an empty array/object where genuinely empty) is what ' +
          'blocks the Ready flip; fill every field from the digest above rather ' +
          'than carrying only `type`.'
        : '') +
      (workflow === 'ops'
        ? ' Stage the next step, then keep driving: once investigation reaches a ' +
          'decision, stage it (a `journal.setState` transition, or a ' +
          '`session.requestCapability` naming the exact write you need) — never ask ' +
          'in chat whether to stage or request first. On a capability grant or an ' +
          'approved staged-proposal, apply the write, reconcile + capture, and ' +
          'advance the ops_journal again; keep looping until it reaches ' +
          '`applied-pending-confirm` or you are genuinely blocked on the next ' +
          'operator decision. Staging/requesting is what puts each decision in ' +
          'front of the operator; asking first inverts the flow and leaves them ' +
          'with nothing to act on.'
        : ''),
  ].join('\n');
}

// ─── per-kind procedure core ────────────────────────────────────────────────

function renderProcedureCore(workflow: PlanningWorkflow): string {
  const label = SKILL_LABELS[workflow];
  const lines: string[] = [`## ${label} Procedure`, ''];
  for (const step of stepsFor(workflow, { dispatched: true })) {
    lines.push(`### ${step.title}`, '', stepSummaryFor(step, workflow), '');
  }
  lines.push('### Hard rules', '');
  for (const principle of principlesFor(workflow)) {
    lines.push(
      `- **${principle.title}**: ${renderPrinciple(principle, workflow)}`,
    );
  }
  return lines.join('\n').replace(/\n+$/, '');
}

// ─── per-type digest ────────────────────────────────────────────────────────

/** Renders the bounded-exploration directive that replaces a bare `(none)` when regions resolve fully empty. */
function renderExplorationDirective(orientation: GroomOrientation): string[] {
  const lines: string[] = [
    '- Code regions: (none resolved — this task declares no path that matched a tracked file)',
    '',
    '### No resolvable code regions — bounded exploration required',
    '',
  ];
  if (
    orientation.milestonePackages.length ||
    orientation.siblingRegions.length
  ) {
    lines.push(
      'No paths declared on this task resolved to tracked files. Below is milestone-wide ' +
        "orientation (not this task's own scope) to seed your search for the actual reference code:",
      '',
      `- Milestone packages touched by other tasks: ${orientation.milestonePackages.length ? orientation.milestonePackages.join(', ') : '(none)'}`,
    );
    if (orientation.siblingRegions.length) {
      lines.push('- Sibling task regions:');
      for (const s of orientation.siblingRegions) {
        lines.push(
          `  - ${s.title} (${s.taskId}): packages: ${s.packages.length ? s.packages.join(', ') : '(none)'}; files: ${s.files.length ? s.files.join(', ') : '(none)'}`,
        );
      }
    }
  } else {
    lines.push(
      'No paths declared on this task resolved to tracked files, and no milestone-wide ' +
        'orientation is available either (this looks like a fresh milestone with no other ' +
        'resolved regions yet).',
    );
  }
  lines.push(
    '',
    'Directive: run one bounded exploration pass (e.g. an Explore agent, or targeted Grep/Read) ' +
      'to bind the reference code this task actually touches, using the orientation above as a ' +
      'starting point. If that pass finds nothing, proceed anyway and note the gap in your ' +
      'findings — do not loop on further exploration.',
  );
  return lines;
}

function renderGroomDigest(data: GroomDigestSlice): string {
  const lines: string[] = [
    '## Grooming Validation Slice',
    '',
    `- Task: ${data.task.title} (${data.task.type}, ${data.task.status}) — ${data.task.url}`,
    `- size_check seed: ${data.sizeCheckSeed.files} files affected (${data.sizeCheckSeed.loc_method})`,
    `- type_check: ${data.typeCheck.decision}${data.typeCheck.signals?.length ? ` — ${data.typeCheck.signals.join('; ')}` : ''}`,
    `- Binding constraints: ${data.bindingConstraints.length ? data.bindingConstraints.join(', ') : '(none)'}`,
  ];
  const hasResolvedRegions =
    data.regions.packages.length > 0 || data.regions.files.length > 0;
  const hasPlanned = data.regions.planned.length > 0;
  if (hasResolvedRegions) {
    lines.push(
      `- Code regions: packages: ${data.regions.packages.length ? data.regions.packages.join(', ') : '(none)'}; files: ${data.regions.files.length ? data.regions.files.join(', ') : '(none)'}`,
    );
    if (hasPlanned) {
      lines.push(
        `- Planned (declared, not yet created): ${data.regions.planned.map((p) => `${p.path}${p.package ? ` → nearest ${p.package}` : ''}`).join(', ')}`,
      );
    }
  } else if (hasPlanned) {
    lines.push(
      `- Code regions: (none resolved) — planned (declared, not yet created): ${data.regions.planned.map((p) => `${p.path}${p.package ? ` → nearest ${p.package}` : ''}`).join(', ')}`,
    );
  } else {
    lines.push(...renderExplorationDirective(data.orientation));
  }
  if (data.readinessViolations.length) {
    lines.push('', '### Readiness violations', '');
    for (const v of data.readinessViolations) {
      lines.push(`- ${JSON.stringify(v)}`);
    }
  }
  if (data.dependencyCandidates) {
    lines.push(
      '',
      '### Dependency candidates',
      '',
      `- Declared: ${data.dependencyCandidates.declaredDeps.length ? data.dependencyCandidates.declaredDeps.join(', ') : '(none)'}`,
      `- Candidate blockers: ${data.dependencyCandidates.candidateBlockers.length ? JSON.stringify(data.dependencyCandidates.candidateBlockers) : '(none)'}`,
    );
  }
  lines.push('', '### Task body', '', data.body || '(empty)');
  return lines.join('\n');
}

function renderDesignDigest(data: DesignDigestSlice): string {
  const lines: string[] = [
    '## Design Investigation Slice',
    '',
    `- Task: ${data.task.title} (${data.task.type}, ${data.task.status}) — ${data.task.url}`,
    `- Open questions (${data.openQuestions.source}): ${data.openQuestions.items.length ? data.openQuestions.items.length : 0}`,
  ];
  for (const q of data.openQuestions.items) {
    lines.push(`  - ${q}`);
  }
  lines.push(
    '',
    `### Arch-store-selected units (${data.archUnits.length})`,
    '',
    ...data.archUnits.map((u) => `- ${u.title} (${u.id})`),
  );
  if (data.unresolvedPageRefs.length) {
    lines.push(
      '',
      '### Unresolved page references',
      '',
      ...data.unresolvedPageRefs.map((p) => `- ${p.title}`),
    );
  }
  lines.push(
    '',
    data.hasCodeMapGrounding
      ? '_Code-map grounding is cached for this milestone — fetch it via GET /api/design-context on demand._'
      : '_No code-map grounding cached yet for this milestone._',
  );
  return lines.join('\n');
}

function renderOpsDigest(data: OpsDigestSlice): string {
  const lines: string[] = [
    '## Ops Journal Slice',
    '',
    `- Task: ${data.task.title} (${data.task.type}, ${data.task.mode}) — ${data.task.url}`,
    `- Depends On: ${data.task.dependsOn.length ? data.task.dependsOn.join(', ') : '(none)'}`,
    `- Dep status: ${data.task.depStatus}`,
  ];
  lines.push(
    '',
    '### Existing ops_journal entry',
    '',
    data.journalEntry
      ? `\`\`\`json\n${JSON.stringify(data.journalEntry, null, 2)}\n\`\`\``
      : '_No prior entry — this is a fresh pass._',
  );
  return lines.join('\n');
}

function renderDigest(digest: PlanningDigest): string {
  switch (digest.workflow) {
    case 'groom':
      return renderGroomDigest(digest.data);
    case 'design':
      return renderDesignDigest(digest.data);
    case 'ops':
      return renderOpsDigest(digest.data);
  }
}

// ─── composer ───────────────────────────────────────────────────────────────

export interface AssemblePlanningProcedureParams {
  taskName: string;
  taskUrl: string;
  digest: PlanningDigest;
  /** The milestone this dispatched session operates under, surfaced verbatim
   *  in the Transport section so the session never greps its own prompt file
   *  for it. */
  milestoneId: string;
  /** The project this dispatched session operates under, surfaced verbatim
   *  in the Transport section for the same reason. */
  projectId: string;
}

/**
 * Compose the full injected planning-procedure prompt: skeleton + per-kind
 * procedure core + per-type digest, in that order. This is the string
 * written to the dispatched session's appended-prompt file.
 */
export function assemblePlanningProcedure(
  params: AssemblePlanningProcedureParams,
): string {
  const { taskName, taskUrl, digest, milestoneId, projectId } = params;
  const sections = [
    renderSkeleton(digest.workflow, taskName, taskUrl, milestoneId, projectId),
    renderProcedureCore(digest.workflow),
    renderDigest(digest),
  ];
  return sections.join('\n\n---\n\n');
}
