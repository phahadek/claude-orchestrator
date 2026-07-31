/**
 * Canonical planning-procedure module — the shared domain core behind the
 * /groom, /design, and /ops skills.
 *
 * Two consumers exist today: the interactive SKILL.md files, which compose
 * it by linking to `skills/_shared/reference/hard-rules.md` (kept in
 * lockstep with `renderHardRulesMarkdown` below — see
 * `procedureCore.test.ts`) instead of restating the cross-cutting rules
 * per-skill; and `procedureAssembler.ts`, the injected assembler
 * (present-and-wait replaced with stage-output) that imports this same
 * module rather than re-deriving the procedure from the vendored SKILL.md
 * prose — that is the drift this module exists to confine to thin
 * execution-mode wrappers.
 *
 * Style: every load-bearing directive added here (a principle `text`, a
 * step `summary`/`summaryOverrides`) follows
 * `packages/backend/src/planning/INJECTED_PROCEDURE_STYLE.md` — terse,
 * imperative DO / DO NOT bullets, IS / IS-NOT lists for load-bearing
 * definitions. Read that file before editing this one.
 */

import { orchestratorMcpToolName } from '../mcp/toolNaming';
import { ALLOWED_TRANSITIONS, type OpsState } from '../ops/opsJournal';

export type SkillId = 'groom' | 'design' | 'ops' | 'split';

/** `blocked` / `incident-frozen` are freezes reachable from (and returning to) any non-terminal state — not part of the normal path. */
const OPS_JOURNAL_FREEZE_STATES: ReadonlySet<OpsState> = new Set([
  'blocked',
  'incident-frozen',
]);

/**
 * The ops_journal normal-path lifecycle order, derived from
 * ALLOWED_TRANSITIONS's own declaration order (freeze states excluded)
 * rather than restated as a second hand-typed list that can drift from it —
 * see opsJournal.ts's ALLOWED_TRANSITIONS doc comment for why this
 * declaration order is the normal path.
 */
export const OPS_JOURNAL_LIFECYCLE_ORDER: readonly OpsState[] = (
  Object.keys(ALLOWED_TRANSITIONS) as OpsState[]
).filter((s) => !OPS_JOURNAL_FREEZE_STATES.has(s));

/** Renders the ops_journal state machine for injection into the ops procedure — states, normal path, and pending's exact legal targets, all read from ALLOWED_TRANSITIONS. */
function renderOpsJournalStateMachine(): string {
  const allStates = (Object.keys(ALLOWED_TRANSITIONS) as OpsState[])
    .map((s) => `\`${s}\``)
    .join(', ');
  const path = OPS_JOURNAL_LIFECYCLE_ORDER.map((s) => `\`${s}\``).join(' → ');
  const pendingTargets = ALLOWED_TRANSITIONS.pending
    .map((s) => `\`${s}\``)
    .join(', ');
  return (
    `The ops_journal states are: ${allStates}. The normal path is ${path} ` +
    '(`blocked` / `incident-frozen` are freezes reachable from, and returning ' +
    'to, any non-terminal state — not part of the normal path). From ' +
    `\`pending\` specifically, the only legal \`journal.setState\` targets are: ` +
    `${pendingTargets} — \`staged-proposal\` is NOT reachable directly from ` +
    '`pending`; stage `candidate` first. This is enforced at both stage time ' +
    'and apply time (the same `isValidOpsTransition` check) — a session that ' +
    'stages an illegal transition is rejected immediately, before it ever ' +
    'reaches the operator.'
  );
}

/**
 * Interactive: a human-typed `/groom`/`/design`/`/ops` skill session with a
 * synchronous chat turn to wait within. Dispatched: an injected, non-
 * interactive planning session (`procedureAssembler.ts`) that ends its turn
 * and parks rather than waiting in chat — see `ORDERED_STEPS`'s
 * `present-for-signoff` summaries for what that inversion means in practice.
 */
export type ExecutionMode = 'interactive' | 'dispatched';

export const SKILL_LABELS: Record<SkillId, string> = {
  groom: 'Grooming',
  design: 'Design Execution',
  ops: 'ops',
  split: 'Split',
};

/** A cross-cutting rule that would otherwise be restated per-skill. */
export interface ProcedurePrinciple {
  id: string;
  title: string;
  appliesTo: readonly SkillId[];
  /** Canonical prose. May contain `{skillLabel}` — resolved per-skill by `renderPrinciple`. */
  text: string;
  /**
   * Per-skill override of `text` for a skill whose terminal move differs from
   * the shared prose — e.g. `ask-permission-not-speculative`'s ops wording
   * abstains into a `needs-setup` journal state that groom/design have no
   * equivalent of; their terminal move is ending the turn with the blocker
   * named instead. Still resolved through `{skillLabel}` substitution.
   */
  textOverrides?: Partial<Record<SkillId, string>>;
  /**
   * True for a rule meaningful only to a human-operated interactive skill
   * session (e.g. confirming a write in chat) — one with no dispatched
   * equivalent because a dispatched session has no synchronous chat turn to
   * confirm within (see `ExecutionMode`). `principlesFor` drops these when
   * called with `{ dispatched: true }`, mirroring `ProcedureStep.skillOnly`.
   */
  interactiveOnly?: boolean;
}

/**
 * The single statement of the design terminal-artifacts ordering rule —
 * referenced (never restated) at every site below that governs one of the
 * ordered artifacts: `design-one-question-per-turn`, the `present-for-signoff`
 * design override, and the `apply-on-signoff` design override, plus the
 * `design-architecture-and-followon-required` principle and the
 * `file-follow-on-tasks` design override. Generalizes what used to be a
 * `task.updateBody`-only rule to the whole class of terminal artifacts an
 * approved decision produces.
 */
export const DESIGN_TERMINAL_ARTIFACTS_ORDERING =
  'Every terminal artifact a Design task produces — the Implementation-notes ' +
  '`task.updateBody`, any `arch.createUnit` / `arch.updateUnit` / ' +
  '`arch.supersedeUnit` write, and the follow-on `task.create` set — is ' +
  'staged only once every listed Open Question is answered and the ' +
  "completeness critic's findings have been accepted: this is not just " +
  '"the critic has run" — `arch.createUnit`/`arch.updateUnit`/' +
  '`arch.supersedeUnit` and the closing-synthesis `task.updateBody` are ' +
  "refused at stage time, naming the missing approval, until the session's " +
  '`completeness.disposition` intent for this task is operator-approved ' +
  '(see "Disposition-don\'t-drop" below). A rejected `completeness.disposition` ' +
  'intent does not require a second critic pass — call the tool again with a ' +
  'revised disposition to stage a fresh intent. This orders artifacts behind ' +
  'answers, and answers behind each other: Open Questions stage one per turn, ' +
  'in the order the task body lists them (see "One Open Question per turn" ' +
  'above), never several at once. EXEMPT: a file-sibling ' +
  "`task.create` (the Split-don't-trim overflow disposition) scopes the " +
  'work rather than following from a locked decision, and may be staged ' +
  'before Open Questions resolve. Once the completeness approval clears, ' +
  'every remaining terminal artifact — the arch.createUnit/arch.updateUnit/' +
  'arch.supersedeUnit writes, the closing-synthesis task.updateBody, and the ' +
  'follow-on task.create set — is staged together under the same shared ' +
  '`groupId` as one design decision, never individually or ungrouped: the ' +
  "operator disposes the design's closing set as a single group-level " +
  'approve/reject, not a scatter of unrelated-looking cards. The ' +
  '`completeness.disposition` intent itself stays outside that group — it ' +
  "is the gate the group's members are refused behind, staged and approved " +
  'on its own before the group exists — and each `decision.pickOne` stays ' +
  'individually staged and ungrouped, one per turn, exactly as "One Open ' +
  'Question per turn" above already requires.';

export const CORE_PRINCIPLES: readonly ProcedurePrinciple[] = [
  {
    id: 'deterministic-load-first',
    title: 'Deterministic load, not hand-fetch',
    appliesTo: ['groom', 'design', 'ops', 'split'],
    text:
      'Load project and task context through the sanctioned deterministic loader ' +
      '(a backend route, or a vendored script that wraps one) before any judgment ' +
      'step. Hand-fetching context pages or task bodies yourself is exactly the step ' +
      'that gets skipped under context pressure — never do it.',
  },
  {
    id: 'human-is-gate',
    title: 'The human is the gate',
    appliesTo: ['groom', 'design', 'ops', 'split'],
    text:
      'Every state-changing decision — a status flip, a locked design decision, an ' +
      'applied operational change — waits for explicit human (operator) sign-off. ' +
      '{skillLabel} proposes; it never self-authorizes the commit.',
  },
  {
    id: 'no-silent-writes',
    title: 'No silent writes',
    appliesTo: ['groom', 'design', 'ops', 'split'],
    interactiveOnly: true,
    text:
      'Every write (a Notion page edit, a status transition, a staged intent) is ' +
      'confirmed in chat before, or at the moment, it is made — never applied and ' +
      'reported after the fact.',
  },
  {
    id: 'git-dash-c-not-cd',
    title: 'Inspect the repo with `git -C`, never `cd && git`',
    appliesTo: ['groom', 'design'],
    text:
      'Inspect the repo with `git -C <repo> …`, never `cd <repo> && git …`. ' +
      '{skillLabel} runs from the projects-root cwd, so the repo is a subdirectory — ' +
      'but the `cd … && git` form prompts every time (Claude Code flags any ' +
      'directory-change-before-git as a hook-execution risk, regardless of ' +
      'allowlist). `git -C <repo> show/log/diff …` is allowlisted and silent. Use ' +
      'path flags for other repo tools too (`npm --prefix`, `uv --project`), not `cd`.',
  },
  {
    id: 'cache-state-files-edit-tool',
    title:
      'Cache/state files are edited with the Edit/Write tool, never a shell script',
    appliesTo: ['groom', 'design'],
    text:
      'Loader-seeded on-disk JSON (grooming-state.json / code-map.json for /groom, ' +
      'design-state.json / code-map.json for /design) is mutated with the Edit tool ' +
      '(a unique-string change) or Read + Write (a structural change). Never write a ' +
      'throwaway script and run it (`node _foo.cjs` then `rm`), and never shell out ' +
      '(`echo >`, `cat >`, a `cd … && …` chain) — that is what causes the constant ' +
      'permission friction, not a workaround for it.',
  },
  {
    id: 'ops-journal-state-machine',
    title: 'ops_journal state machine',
    appliesTo: ['ops'],
    text: renderOpsJournalStateMachine(),
  },
  {
    id: 'dispatched-ops-write-capable',
    title:
      'A dispatched ops run is write-capable — drive to applied-pending-confirm, never park a staged proposal',
    appliesTo: ['ops'],
    text:
      'A dispatched {skillLabel} run IS write-capable: it earns capabilities on ' +
      'request and drives the ops_journal to `applied-pending-confirm` (the change ' +
      'actually applied, reconciled, evidence captured) through the ' +
      'request → grant → apply → reconcile loop. IS NOT: a session limited to ' +
      'staging a proposal and parking it for someone else to execute — that is ' +
      'not the target terminal for work this session can perform, or can become ' +
      'equipped to perform. DO keep driving the journal — stage the next legal ' +
      'transition, apply once a capability is granted or a proposal is approved, ' +
      'reconcile and capture evidence, repeat — until it reaches ' +
      '`applied-pending-confirm`, rather than stopping at `staged-proposal` (or ' +
      'any other non-terminal state) merely because every prerequisite for that ' +
      'state is satisfied. DO NOT treat "the proposal is ready to stage" as a ' +
      'stopping point when the session already holds, or could earn by request, ' +
      'the tool needed to carry it further. A missing write tool IS a capability ' +
      'request, never a blocker: DO call ' +
      `\`${orchestratorMcpToolName('session.requestCapability')}\` the moment a ` +
      "write the task needs is outside this session's tools, with " +
      '`{"payload":{"capability":"<the exact tool or capability>","plan":"<what ' +
      'you will do once granted>","evidence":"<why this write is needed>"}}` — ' +
      'then end the turn and wait to be re-dispatched, and apply the write once ' +
      're-dispatched with it granted. DO NOT record the missing tool as `blocked` ' +
      'or `needs-setup` when a capability request can reach it — request first. ' +
      'A genuine external blocker (no sanctioned request path resolves it: a real ' +
      'dependency has not landed, an external system is down, the decision is ' +
      "only a human's to make) still terminates as `blocked` / `needs-setup`, " +
      'naming the blocker explicitly — that terminal stays legitimate and is not ' +
      'what this rule forbids.',
  },
  {
    id: 'atomic-single-action-request',
    title: 'Atomic single-action requests',
    appliesTo: ['ops'],
    text:
      'Every command a dispatched {skillLabel} session requests is exactly one action per ' +
      'invocation — never a chained or bundled sequence (`&&`, `;`, a multi-step script). ' +
      'This is load-bearing for grant safety: a human approving a capability grant is ' +
      'approving *that one command*, not whatever it might trigger next.',
  },
  {
    id: 'dispatch-eligibility-boundary',
    title: 'Dispatch-eligibility boundary',
    appliesTo: ['ops'],
    text:
      'Diagnosis and reversible/resumable writes are what suit a dispatched (non-interactive) ' +
      '{skillLabel} session. Irreversible/non-resumable writes and live-incident recovery lean ' +
      'interactive — hand those to an operator-present run instead of dispatching them. ' +
      'Authoring or rewriting a file — a script, a config, a deploy playbook — is always a ' +
      '💻 Code task, never {skillLabel}, regardless of how reversible the change looks: ' +
      '{skillLabel} proposes the content (a staged intent, a chat write-up) and a Code task ' +
      'applies it with the Write/Edit tools {skillLabel} does not have.',
  },
  {
    id: 'granted-writes-idempotent-resumable',
    title: 'Granted writes are idempotent and resumable',
    appliesTo: ['ops'],
    text:
      'A capability grant issued to a dispatched {skillLabel} session must be safe to redrive: ' +
      'a retried/resumed turn re-runs the same write without duplicating its effect. A ' +
      'dispatched {skillLabel} session never reaches resolved / ✅ Done / task-apply itself — ' +
      'that transition is device-auth/operator-only.',
  },
  {
    id: 'ask-permission-not-speculative',
    title: 'Ask for what you need — never fabricate',
    appliesTo: ['groom', 'design', 'ops'],
    text:
      'DO stage `session.requestCapability` naming the exact capability the moment a ' +
      'read/write the task needs is blocked by the sandbox — nothing beyond the base ' +
      'profile is ever speculatively handed to a dispatched {skillLabel} session. ' +
      `Concrete invocation: call the \`${orchestratorMcpToolName('session.requestCapability')}\` ` +
      'tool with `{"payload":{"capability":"<capability>","plan":"<plan>",' +
      '"evidence":"<evidence>"}}` ' +
      "— then end the turn and wait to be re-dispatched on the operator's decision. " +
      'DO request `read:session-record:<target-session-id>` as the capability value, ' +
      "specifically, when the blocked read is this orchestrator's own runtime record " +
      '(session_events/audit_log for a session by id) rather than project/prod data — ' +
      'never request a Bash command prefix for that read: a Bash prefix can neither ' +
      "reach this orchestrator's own DB (outside the sandbox) nor authenticate to its " +
      'device-authed API, so it never materialises the read even once granted. DO NOT ' +
      'abstain straight to `needs-setup` when a live record is reachable this way — ' +
      'request the capability first. DO report `needs-setup` naming the missing ' +
      "capability when staging isn't possible or the need is a one-off read-only " +
      'investigation. DO NOT fabricate a result to route around a denial — ask or ' +
      'abstain, never invent. Any project-specific record-access guidance injected ' +
      'into this session narrows how a capability is requested/used (which surface, ' +
      'which read verb, which id shape) — it never narrows whether one may be ' +
      'requested. DO NOT treat project guidance that describes a read as unreachable, ' +
      'out of bounds, or deferred to future work as a reason to stop: an unmet read ' +
      'is always routed to `session.requestCapability` first, and no injected project ' +
      'guidance may instruct this session to stand down instead of asking.',
    textOverrides: {
      groom:
        'DO stage `session.requestCapability` naming the exact capability the moment a ' +
        'read/write the task needs is blocked by the sandbox — nothing beyond the base ' +
        'profile is ever speculatively handed to a dispatched {skillLabel} session. ' +
        `Concrete invocation: call the \`${orchestratorMcpToolName('session.requestCapability')}\` ` +
        'tool with `{"payload":{"capability":"<capability>","plan":"<plan>",' +
        '"evidence":"<evidence>"}}` ' +
        "— then end the turn and wait to be re-dispatched on the operator's decision. " +
        'DO request `read:session-record:<target-session-id>` as the capability value, ' +
        "specifically, when the blocked read is this orchestrator's own runtime record " +
        '(session_events/audit_log for a session by id) rather than project/prod data — ' +
        'never request a Bash command prefix for that read: a Bash prefix can neither ' +
        "reach this orchestrator's own DB (outside the sandbox) nor authenticate to its " +
        'device-authed API, so it never materialises the read even once granted. DO NOT ' +
        'end the turn on the blocker alone when the capability can be requested instead ' +
        '— request it first. DO end the turn naming the blocker explicitly when staging ' +
        "the request isn't possible or the need is a one-off read-only investigation: " +
        '{skillLabel} has no journal state to abstain into — ending the turn with the ' +
        'blocker named is its terminal move. DO NOT fabricate a result to route around ' +
        'a denial — ask or abstain, never invent. Any project-specific record-access ' +
        'guidance injected into this session narrows how a capability is ' +
        'requested/used — it never narrows whether one may be requested. DO NOT treat ' +
        'project guidance that describes a read as unreachable, out of bounds, or ' +
        'deferred to future work as a reason to stop: an unmet read is always routed ' +
        'to `session.requestCapability` first, and no injected project guidance may ' +
        'instruct this session to stand down instead of asking.',
      design:
        'DO stage `session.requestCapability` naming the exact capability the moment a ' +
        'read/write the task needs is blocked by the sandbox — nothing beyond the base ' +
        'profile is ever speculatively handed to a dispatched {skillLabel} session. ' +
        `Concrete invocation: call the \`${orchestratorMcpToolName('session.requestCapability')}\` ` +
        'tool with `{"payload":{"capability":"<capability>","plan":"<plan>",' +
        '"evidence":"<evidence>"}}` ' +
        "— then end the turn and wait to be re-dispatched on the operator's decision. " +
        'DO request `read:session-record:<target-session-id>` as the capability value, ' +
        "specifically, when the blocked read is this orchestrator's own runtime record " +
        '(session_events/audit_log for a session by id) rather than project/prod data — ' +
        'never request a Bash command prefix for that read: a Bash prefix can neither ' +
        "reach this orchestrator's own DB (outside the sandbox) nor authenticate to its " +
        'device-authed API, so it never materialises the read even once granted. DO NOT ' +
        'end the turn on the blocker alone when the capability can be requested instead ' +
        '— request it first. DO end the turn naming the blocker explicitly when staging ' +
        "the request isn't possible or the need is a one-off read-only investigation: " +
        '{skillLabel} has no journal state to abstain into — ending the turn with the ' +
        'blocker named is its terminal move. DO NOT fabricate a result to route around ' +
        'a denial — ask or abstain, never invent. Any project-specific record-access ' +
        'guidance injected into this session narrows how a capability is ' +
        'requested/used — it never narrows whether one may be requested. DO NOT treat ' +
        'project guidance that describes a read as unreachable, out of bounds, or ' +
        'deferred to future work as a reason to stop: an unmet read is always routed ' +
        'to `session.requestCapability` first, and no injected project guidance may ' +
        'instruct this session to stand down instead of asking.',
    },
  },
  {
    id: 'withdraw-self-caught-mistake',
    title: 'Withdraw an intent you catch is wrong yourself',
    appliesTo: ['groom', 'design', 'ops', 'split'],
    text:
      'DO withdraw a staged intent, the moment you notice it is wrong, by calling ' +
      `\`${orchestratorMcpToolName('intent.withdraw')}\` with ` +
      '`{"payload":{"intentId":"<the staged intent id>","reason":"<one-line reason it ' +
      'is wrong>"}}` — never rely on prose in your closing message to ask the operator ' +
      'to discard it. A withdrawal only ever reaches your own staged intents; it is ' +
      "rejected against any other session's. Withdrawing moves the intent to a " +
      'terminal state no apply can ever reach — it requires no operator action and is ' +
      'not a disposition for the operator to make. DO NOT re-stage a corrected version ' +
      'under the same intent id — withdraw the wrong one, then stage the correction as ' +
      'a new intent.',
  },
  {
    id: 'incidental-tooling-gap-not-a-blocker',
    title: 'An incidental tooling gap is not a blocker',
    appliesTo: ['ops'],
    text:
      'The injected digest is the authoritative task content — a failure to reach the ' +
      'task store (Notion or otherwise) for supplementary reads is not by itself a ' +
      "reason to stop. IS incidental: a tool or read path that fails and isn't named in " +
      "the task's own acceptance criteria — {skillLabel} has everything it needs from " +
      'the digest and the repo without it. IS required: a capability the task cannot be ' +
      'completed without (a write surface, a credential, a read the acceptance criteria ' +
      'depend on) — that stays governed by "Ask for what you need" above: request it ' +
      'with `session.requestCapability`, or report `needs-setup` when a real blocker ' +
      'remains. DO, on an incidental gap, file it as a follow-on `task.create` once, ' +
      'record it in the journal in a single line, and continue executing the ' +
      "mandate's remaining steps with the tools that do work. DO NOT re-stage " +
      '`journal.setState` about the same incidental gap more than once — the follow-on ' +
      'task is the durable record, not an evolving journal narrative. DO NOT end the ' +
      'turn, stall, or wait on operator input over an incidental gap alone. DO NOT ' +
      'fabricate or guess at what the missing read would have returned — proceed only ' +
      'on what the digest and the parts of the task reachable without it actually show.',
  },
  {
    id: 'investigate-before-resolving-no-deferral',
    title: 'Investigate before resolving — a defer is not a resolve',
    appliesTo: ['groom', 'design'],
    text:
      'Reading the code comes before deciding what is resolved. Every open question ' +
      '{skillLabel} proposes to close is either locked now (cite the finding or the ' +
      'decision it rests on) or kept as an explicit Open Question — there is no third ' +
      'state. "Decide at implementation time," "leave it to the implementer," ' +
      '"implementer\'s call," or any equivalent phrasing that punts a choice to the ' +
      'implementing session is a _defer_, not a _resolve_ — never stage it as a ' +
      'resolved question, an Open Questions value of "None," or any other framing ' +
      'that launders a defer into a resolution. A task carrying that language is not ' +
      'Ready; either resolve the question now or leave it open and keep the task at ' +
      '🔲 Backlog. (📋 Planning, 📐 Design, 🔎 Investigation, and 🧪 Testing tasks are ' +
      'exempt from this check on their own open-question-space — see ' +
      "`readinessGate.ts`'s `OPEN_QUESTIONS_EXEMPT_TYPES` — because for those types " +
      'the open questions are the deliverable being scoped, not a precondition being ' +
      'dodged. For an Investigation or observational Testing task specifically, the ' +
      'unresolved question is the payload it carries into execution: report it ' +
      'honestly in groomProposal.openQuestions and promote the task with it — never ' +
      'launder it into "None," and never hold the task at Backlog on the theory that ' +
      'an unresolved question forbids Ready. Every non-exempt type keeps the rule ' +
      'above unchanged: a 💻 Code task with an unresolved trade-off still stays at ' +
      'Backlog.)',
  },
  {
    id: 'decision-pickone-genuine-forks-only',
    title: 'decision.pickOne is for genuine forks only',
    appliesTo: ['groom', 'ops'],
    text:
      'Reserve `decision.pickOne` for a genuine fork {skillLabel} cannot resolve ' +
      'confidently — a question only the operator can decide. When {skillLabel} is ' +
      'confident in one path, stage that proposal normally (its concrete write, with a ' +
      'decisionProposal explaining the reasoning) and let a reject-with-pushback carry ' +
      'any correction — never manufacture a decision.pickOne to hedge on a call ' +
      '{skillLabel} is equipped to make, and never use it as a general-purpose ' +
      'confirmation prompt.',
  },
  {
    id: 'decision-pickone-genuine-forks-only-design-scope',
    title: 'decision.pickOne is for genuine forks only — Design scope',
    appliesTo: ['design'],
    text:
      'Reserve `decision.pickOne` for a genuine fork {skillLabel} cannot resolve ' +
      'confidently — a question only the operator can decide — but ONLY for an ' +
      'incidental sub-decision made along the way. This confidence routing NEVER ' +
      "applies to a 📐 Design task's listed Open Questions: every listed Open " +
      'Question stages as its own `decision.pickOne` regardless of confidence (one ' +
      'option when the answer is a confident recommendation, two-or-more for a real ' +
      "fork) — see 'One Open Question per turn' below. A listed Open Question is never routed " +
      'to a concrete write to "lock it in" — `task.updateBody` (Implementation ' +
      'notes) only consolidates decisions already accepted by the operator; it is ' +
      'never the vehicle for making one.',
  },
  {
    id: 'groom-operator-judgment-question-intent',
    title:
      'Raise an operator-judgment finding as decision.pickOne, never a status no-op',
    appliesTo: ['groom'],
    text:
      'A finding that turns on a judgment only the operator can make — the ' +
      "task's scope is wrong, a dependency cannot be confirmed, the spec " +
      'contradicts the code — is raised as its own `decision.pickOne` ' +
      'question-intent, `options` carrying the candidate resolutions (e.g. ' +
      'widen scope / file a sibling task / proceed as specified), never ' +
      'smuggled through a `task.setStatus` staged to the status the task ' +
      'already holds. DO NOT stage a no-op `task.setStatus` — the payload ' +
      "status equal to the task's current status — as a vehicle for a " +
      'finding, whatever the channel: once `decision.pickOne` exists there is ' +
      'no remaining excuse for it. `task.setStatus` is staged only when the ' +
      'status is actually changing. DO NOT treat a scope gap as automatically ' +
      'a body edit: appending to Future Scope (or any other section) ' +
      "silently commits {skillLabel}'s own resolution when that resolution " +
      'is the operator’s to make — ask via `decision.pickOne` first, and ' +
      'edit the body only once the answer is known. This is not a punt ' +
      'channel: the anti-deferral discipline stands (see "Investigate before ' +
      'resolving" above) — a readiness judgment {skillLabel} is equipped to ' +
      'resolve is still resolved now, never handed to the operator as a ' +
      'question just because asking is available. `decision.pickOne` is for ' +
      "a decision genuinely outside a groomer's authority — changing what " +
      'the task is — not a way to hand back a readiness call {skillLabel} is ' +
      'supposed to make itself.',
  },
  {
    id: 'design-one-question-per-turn',
    title:
      'One Open Question per turn, in task-body order — no parallel staging',
    appliesTo: ['design'],
    text:
      "DO stage exactly one Open Question's resolution per `decision.pickOne` " +
      'intent (options = the candidate answers — a single option is a confident ' +
      'recommendation the operator accepts or pushes back on, not just a genuine ' +
      'fork), never a `task.updateBody` edit, and never two questions bundled into ' +
      'one intent. DO investigate before deciding — cite the code read, arch-page ' +
      'section, or API-call result the resolution rests on; "decide at ' +
      'implementation time" is a _defer_, never a _resolve_. DO handle the task ' +
      "body's listed Open Questions one at a time, in the order they are written: " +
      'stage the one `decision.pickOne` intent for the question currently in hand, ' +
      'end the turn, and move to the next question only once the operator has ' +
      "disposed of this one — {skillLabel}'s own read of which questions look " +
      '"independent" is not a reliable guard against staging two whose answers turn ' +
      'out coupled; treat every question as potentially dependent until the prior ' +
      'one is actually locked. DO hold a question whose answer depends on another ' +
      'still-unresolved question, and say so plainly — name the question it depends ' +
      'on and why — rather than staging it alongside or ahead of that question. ' +
      'DO NOT stage two Open Questions, however independent they appear, in the ' +
      'same turn. DO NOT bundle multiple questions into one `decision.pickOne` ' +
      'intent. Expect a question the operator pushes back on to come back as a ' +
      'fresh `decision.pickOne` intent rather than a revision of the committed one ' +
      '— a committed intent cannot be superseded (see ' +
      '"Pushback is iteration, not sign-off" below). `task.updateBody` (the ' +
      'Implementation notes) is staged exactly once, the last of the ' +
      'decision-recording steps. ' +
      DESIGN_TERMINAL_ARTIFACTS_ORDERING +
      " It is not the end of the design pass — see 'Architecture and follow-on " +
      "tasks are required deliverables' below for what still follows it in the " +
      'same session.',
  },
  {
    id: 'design-decision-pickone-payload-shape',
    title:
      'decision.pickOne payload shape mirrors the 5-part question presentation',
    appliesTo: ['design'],
    text:
      'DO shape every Open Question’s `decision.pickOne` payload to carry a ' +
      '5-part question contract — the question, the candidate options with each ' +
      'one’s own trade-offs, a rejected option retained alongside the accepted one, ' +
      'the supporting evidence, and a named recommendation — mapped onto the ' +
      'payload’s fields (`prompt`, `options[]`, `decisionProposal`) rather than a ' +
      'second, drifting restatement of that contract. `prompt` carries the question ' +
      'alone — quote it concisely; DO NOT restate the candidate answers inline, ' +
      'those belong in `options`. DO stage one `options[]` entry per candidate ' +
      'solution considered, including a candidate {skillLabel} recommends against ' +
      '— DO NOT omit a rejected candidate because it lost, and DO NOT fold its ' +
      'rationale into a competing option’s description. DO write each option’s ' +
      '`description` as a self-contained, architecture-level statement of that one ' +
      'candidate plus its own trade-offs — DO NOT let it carry another option’s ' +
      'rationale, and DO NOT concatenate every candidate’s analysis into a single ' +
      'option’s field. DO carry evidence — file:line citations, arch-page section ' +
      'names, API-result specifics — in `decisionProposal`’s investigation summary ' +
      'rather than inside an option description; this evidence requirement still ' +
      'applies, this only relocates where it is carried, since the payload has no ' +
      'separate Investigation field. DO name the preferred solution and its ' +
      'load-bearing reason explicitly in `decisionProposal`, alongside that ' +
      'investigation summary. A single `options` entry stays valid — a confident ' +
      'recommendation the operator accepts or pushes back on (see ‘One Open ' +
      'Question per turn’ above) — this shape governs how it, or each of several, ' +
      'is written, never whether more than one is required. See "Option framing" ' +
      'below for what belongs in an option’s `description` specifically.',
  },
  {
    id: 'design-recommendation-quality',
    title:
      'Recommendation quality — reuse before new machinery, minimal scope, verify before locking',
    appliesTo: ['design'],
    text:
      'DO state explicitly, before recommending any new surface, store, table, or ' +
      "field, why the project's existing primitives don't already compose to solve " +
      "the problem — if that gap can't be articulated, recommend reusing what " +
      'exists instead of building new machinery. DO name the wider set of options ' +
      'considered (including the broadest mechanism available) but default the ' +
      'recommendation itself to the smallest scope that solves the problem the ' +
      'Open Question actually poses — recommending the broadest available scope ' +
      '"since it is more general" is a framing defect, not a virtue. DO verify a ' +
      'recommendation’s load-bearing mechanism with the cheapest available probe — ' +
      'a code read, a grep for the code path in question, a single live API call ' +
      '— before locking it in; a mechanism assumed to work from its name or its ' +
      'apparent purpose is not verified. DO NOT assert any system state — a ' +
      'component exists, a change has shipped, a service is running, a bug is ' +
      'fixed — as the premise of a recommendation without checking it against the ' +
      "current code or a live call: 'shipped' and 'designed', and 'merged to the " +
      "repo' and 'present on disk locally', are different states, and the " +
      'dispatch model itself (what a dispatched session can and cannot do in a ' +
      'turn) is exactly this kind of state to verify rather than assume. An ' +
      '"advisory" signal (a trace-coverage hint, a completeness-critic finding) ' +
      'scopes {skillLabel}’s authority to override it — it does not remove the ' +
      'obligation to investigate it with the same rigor as any other input to a ' +
      'recommendation.',
  },
  {
    id: 'design-pushback-is-iteration-not-signoff',
    title:
      'An operator disposition carrying pushback is iteration, not sign-off',
    appliesTo: ['design'],
    text:
      'DO treat an operator disposition on a staged `decision.pickOne` that carries ' +
      'a factual correction, a reframe of the question, or a new option ' +
      '{skillLabel} had not considered as iteration data, never as approval of the ' +
      'closest-matching staged option — investigate the claim it makes, re-stage ' +
      'the question as a fresh `decision.pickOne` intent (a committed intent cannot ' +
      'be superseded, so the prior one stays committed and the revised question is ' +
      'a new intent), and ask again. DO NOT fold the content of a pushback straight ' +
      'into a "locked" answer without independently verifying it first — a reframe ' +
      'carries its own premises, and those premises are re-derived (a code read, an ' +
      'arch-page check, a live call) before they become premises of the next ' +
      'recommendation, exactly as any other unverified claim would be (see "Verify ' +
      'the task body\'s premises" below). Expect this to add park/resume round ' +
      'trips relative to a single-pass bundle of questions; that is the intended ' +
      'trade for never locking a question against an answer the operator has not ' +
      'actually given.',
  },
  {
    id: 'design-option-framing',
    title:
      'Option framing — architecture-level shape, evidence stays in decisionProposal, a contrast pair required',
    appliesTo: ['design'],
    text:
      'Extends "decision.pickOne payload shape" above. An option’s `description` ' +
      'carries the architectural shape of that candidate and its own trade-off — ' +
      'the boundary it draws, the surface it touches, what it costs to build or to ' +
      'live with — never an implementation-level restatement of the question ' +
      'itself (which function, which line, which config flag) in place of that ' +
      'architectural framing. DO NOT put evidence — file:line citations, arch-page ' +
      'section names, API-result specifics — inside an option `description`; that ' +
      'evidence belongs in `decisionProposal`’s investigation summary, and only ' +
      'there. DO include an explicit rejected/accepted contrast pair among the ' +
      'staged options — at least one option stated as genuinely considered and ' +
      'rejected, with the reason it lost, sitting alongside the accepted one — ' +
      'never only the winning option dressed up with a rationale and no real ' +
      'counterpart. Two to three options is the sweet spot: `options[]` is not a ' +
      'survey of every conceivable variant, and the recommendation named in ' +
      '`decisionProposal` is a judgment call {skillLabel} is making, not a summary ' +
      'of the field for the operator to judge from scratch. An option written in ' +
      'implementation terms rather than architectural terms is a framing defect ' +
      'even when its content is otherwise correct — an operator rejecting an ' +
      'implementation-framed option is rejecting the framing, not necessarily the ' +
      'underlying choice.',
  },
  {
    id: 'design-verify-the-body-premise',
    title: "Verify the task body's premises before resolving against them",
    appliesTo: ['design'],
    text:
      "A Design task's body states facts as part of framing its Open Questions — " +
      'that a component exists, that a mechanism behaves a certain way, that prior ' +
      'work already handles some case — and those are claims to re-derive, never ' +
      'givens to resolve against. DO NOT lock an Open Question’s answer without ' +
      "reading the code the body's claim is actually about — a body-stated premise " +
      'is exactly as unverified as a claim raised mid-pushback (see "Pushback is ' +
      'iteration, not sign-off" above) until it has been checked against the ' +
      'current source. DO NOT lock a decision that depends on an external API’s ' +
      'behavior without a live call verifying that behavior — a remembered or ' +
      'documented contract is not the same thing as the contract the deployed ' +
      'service actually honors today. A task body authored days or milestones ' +
      'earlier may describe a system that has since changed; treat its premises as ' +
      'claims about the codebase’s state at body-authoring time, never as claims ' +
      'about its state now.',
  },
  {
    id: 'design-completeness-critic',
    title: 'Completeness critic — once per task, before the closing synthesis',
    appliesTo: ['design'],
    text:
      'DO run the completeness critic exactly once per Design task, after every ' +
      'listed Open Question is locked and before staging the ' +
      '`task.updateBody` closing synthesis. DO probe the recurring gap ' +
      'classes — a decision the implementer needs that no locked question ' +
      'covers — consuming the advisory trace-coverage signal ' +
      `(the \`${orchestratorMcpToolName('completeness.traceCoverage')}\` tool) ` +
      'as an aid, never a gate: no ' +
      'locked-decision-count threshold, no promotion block. DO NOT skip the critic ' +
      'pass because every listed question already locked cleanly — the pass exists ' +
      'to surface gaps no question named. DO carry every gap the pass raises, and ' +
      'its proposed disposition, into the closing synthesis’s "Completeness-critic ' +
      'dispositions" section for operator sign-off — DO NOT treat the pass as ' +
      'finished once it has run and been recorded; recording is not presenting.',
  },
  {
    id: 'design-disposition-dont-drop',
    title: "Disposition-don't-drop",
    appliesTo: ['design'],
    text:
      'DO dispose every candidate the completeness critic raises with one of the ' +
      'named dispositions — `resolved` / `out-of-scope` / `not-a-decision` / `fold` ' +
      '/ `file-sibling` / `sibling-owned` — and a recorded reason; the named value ' +
      'is stored verbatim, never collapsed to a binary accepted/dismissed. DO call ' +
      `the \`${orchestratorMcpToolName('completeness.disposition')}\` tool with ` +
      '`{taskId, probed: [<every gap class actually checked>], questions: ' +
      '[{question, disposition: <named value>, reason, approvalStatus: "proposed"}], ' +
      'runAt}` at critic time, for every critic run — this durable store, never ' +
      'body prose, is the record, and it is written immediately so nothing is ' +
      'silently lost even before the operator has seen it. `probed` is never empty: ' +
      'a clean pass (no gaps) still names every gap class the critic checked, so ' +
      'the record reads as an affirmative "ran clean," never as indistinguishable ' +
      'from a skipped run. This same call also stages a `completeness.disposition` ' +
      'intent for ' +
      'operator approval — DO wait for that intent to be approved before staging ' +
      'any `arch.createUnit` / `arch.updateUnit` / `arch.supersedeUnit` write, the ' +
      'closing-synthesis `task.updateBody`, or the follow-on `task.create` set (see ' +
      'DESIGN_TERMINAL_ARTIFACTS_ORDERING above) — staging one earlier is rejected ' +
      'at stage time, naming the missing approval. DO NOT drop a candidate silently. ' +
      'DO NOT record a disposition only ' +
      'as Implementation-notes prose; prose may summarize it, but the store call is ' +
      'the disposition. DO NOT confuse "recorded" with "approved": a `proposed` ' +
      'disposition is provisional until the operator approves the staged ' +
      '`completeness.disposition` intent — a rejected intent is not a dead end: ' +
      're-call the tool with a revised disposition/reason to stage a fresh intent, ' +
      'never a second critic pass, and never treating the first write as final.',
  },
  {
    id: 'design-closing-synthesis',
    title: 'Closing synthesis — the terminal decisionProposal, not a body diff',
    appliesTo: ['design'],
    text:
      'DO carry the three-part authored synthesis below as the ' +
      '`decisionProposal` of the ' +
      '`task.updateBody` intent: (1) Decision summary — one paragraph on what was ' +
      'decided and why; (2) Open questions resolved — a table, one row per listed ' +
      'Open Question, included only when there are ≥2 questions; (3) Completeness-' +
      'critic dispositions — every gap the pass raised, its disposition, and the ' +
      'run date, or "none — pass run, no gaps" when clean. DO NOT author parts 4 ' +
      '("Architecture pages updated") and 5 ("Follow-on Code tasks filed") — ' +
      'stagedIntents.ts generates both, at the moment the closing synthesis ' +
      'stages, from the architecture-unit / `task.create` intents (and any ' +
      '`planning.noOp` markers) already staged this pass, and appends them to ' +
      'both `decisionProposal` and the body write’s Implementation-notes content. ' +
      'The generated text is not this session’s to write — writing it anyway ' +
      'only duplicates what the stage-time generator already produces from the ' +
      'same staged set. DO frame the operator’s decision as approving ' +
      'this synthesis — the body write is its consequence, not a separate thing to ' +
      'diff. DO NOT ask the operator to validate the `task.updateBody` payload’s ' +
      'prose as if reviewing a diff; the synthesis is the reviewable artifact, ' +
      'carried in `decisionProposal`, not the body text itself. DO NOT fold the ' +
      'decision summary straight into the write without the other two authored ' +
      'parts — all three sections are required every time, per the skill’s hard ' +
      'checkpoint. Staging this `task.updateBody` before every expected terminal ' +
      'kind is accounted for (an architecture write and a follow-on `task.create`, ' +
      'each either staged or covered by a `planning.noOp` naming it — see ' +
      '"design-architecture-and-followon-required" below) is refused at stage ' +
      'time, naming the unaccounted-for kind.',
  },
  {
    id: 'design-architecture-and-followon-required',
    title:
      'Architecture pages and follow-on Code tasks are required deliverables',
    appliesTo: ['design'],
    text:
      'A 📐 Design task exists to produce two things beyond the locked decisions ' +
      'themselves — updated architecture pages and filed follow-on 🔲 Backlog Code ' +
      'tasks (see config/procedures.md § Task types) — and both are staged in the ' +
      'same pass as the decisions that imply them, never left for the operator to ' +
      'request afterward. ' +
      DESIGN_TERMINAL_ARTIFACTS_ORDERING +
      ' DO stage the architecture-unit change(s) each locked ' +
      'decision implies (`arch.createUnit` / `arch.updateUnit` / ' +
      '`arch.supersedeUnit`) once the decisions touching that unit are locked, ' +
      'rather than only describing the change in chat. DO stage the implementation ' +
      'work a locked design implies as `task.create` intents (landing at 🔲 ' +
      'Backlog, typed 💻 Code) in this same pass — this is not limited to the ' +
      "'Split-don't-trim' overflow case below; any locked design that implies code " +
      'work files that work now. DO stage a `planning.noOp` naming the skipped ' +
      'kind (`{taskId, reason, skippedKind: "task.create"}` or ' +
      '`skippedKind: "architecture"`) when the locked decisions genuinely touch no ' +
      'architecture page, or spawn no follow-on task — silence is never an ' +
      'acceptable substitute for that statement, mirroring the disposition-don’t-' +
      'drop rule the completeness critic follows above. This is enforced, not just ' +
      'advisory: the closing-synthesis `task.updateBody` is refused at stage time, ' +
      'naming the unaccounted-for kind, until each of `task.create` and the ' +
      'architecture-unit writes is satisfied — by ≥1 staged intent of that kind, or ' +
      'by a `planning.noOp` naming it (one `planning.noOp` per skipped kind, never ' +
      'one covering both). DO NOT treat this as a numeric gate: there is no minimum ' +
      'count of architecture units or follow-on tasks, and neither is wired into a ' +
      'promotion block — gating on the presence of a statement is a different thing ' +
      'from gating on its content or count, the same posture the trace-coverage ' +
      'signal already takes.',
  },
  {
    id: 'design-split-dont-trim',
    title: "Split-don't-trim",
    appliesTo: ['design'],
    text:
      'DO handle a too-large decision space with the `file-sibling` disposition — ' +
      'stage a `task.create` intent for a sibling 📐 Design task and carry the ' +
      'overflow questions there. DO NOT trim or drop questions just to shrink the ' +
      'set. Question-count (`>~6`) IS a soft diagnostic prompting you to consider ' +
      'splitting; it IS NOT a numeric trigger and IS NOT wired into `size_check`.',
  },
  {
    id: 'create-then-wire-dependency',
    title: 'Create-then-wire: staging a dependency on a task you just staged',
    appliesTo: ['groom', 'design', 'ops'],
    text:
      'When a `task.create` you stage in this pass is itself a prerequisite an ' +
      'existing task needs, DO stage the `task.setDependsOn` edge onto it in the ' +
      'same group in the same pass — name it in the `dependsOn` array as ' +
      "`staged-intent:<the task.create intent's own id>` (the id the stage call " +
      "returned), not the task's real id, which does not exist yet. The commit " +
      'loop resolves that reference to the real created task id once the ' +
      '`task.create` applies, before the `task.setDependsOn` applies. DO NOT hand ' +
      'the operator a manual "apply the create, then point Depends On at the ' +
      'resulting id" follow-up, and DO NOT fabricate a plausible-looking task id ' +
      'to unblock staging — both were the only recourse before this affordance ' +
      'existed, and both leave the dependency unenforced or the stage rejected. ' +
      'The symbolic reference resolves only within its own staged-intent group — ' +
      'it can never name a `task.create` staged in a different group.',
  },
] as const;

/** Resolve `{skillLabel}` against the given skill and return the finished prose. */
export function renderPrinciple(p: ProcedurePrinciple, skill: SkillId): string {
  const text = p.textOverrides?.[skill] ?? p.text;
  return text.replace(/\{skillLabel\}/g, SKILL_LABELS[skill]);
}

export function principlesFor(
  skill: SkillId,
  context: { dispatched?: boolean } = {},
): ProcedurePrinciple[] {
  return CORE_PRINCIPLES.filter(
    (p) =>
      p.appliesTo.includes(skill) && !(context.dispatched && p.interactiveOnly),
  );
}

/**
 * Canonical markdown for `skills/_shared/reference/hard-rules.md` — the
 * single copy every applicable SKILL.md links to instead of restating.
 * `procedureCore.test.ts` asserts the on-disk file matches this output
 * byte-for-byte, so the module (not the vendored markdown) stays the
 * source of truth.
 */
export function renderHardRulesMarkdown(): string {
  const lines: string[] = [
    '# Shared planning-procedure hard rules',
    '',
    'Canonical source: `packages/backend/src/planning/procedureCore.ts` ' +
      '(`CORE_PRINCIPLES`). Do not edit this file directly — regenerate it from ' +
      'the module (see `procedureCore.test.ts`) and update the module instead.',
    '',
  ];
  for (const p of CORE_PRINCIPLES) {
    lines.push(`## ${p.title}`, '');
    for (const skill of p.appliesTo) {
      lines.push(`- **${SKILL_LABELS[skill]}**: ${renderPrinciple(p, skill)}`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * Ordered shape of a planning session: resolve manifest/mode, load
 * deterministically, investigate, present for sign-off, incorporate
 * feedback, apply on sign-off. /groom and /design both instantiate this
 * shape directly (see their Step 0–4 headers); /ops instantiates the same
 * underlying phases under its own Flow numbering (detect context / load
 * context / first-pass diagnose / present order / walk-and-resolve) because
 * it has no per-task open-question queue to walk one item at a time.
 */
export interface ProcedureStep {
  id: string;
  title: string;
  appliesTo: readonly SkillId[];
  summary: string;
  /**
   * True for a step meaningful only to the human-operated /groom or /design
   * skill (reading the on-disk grooming manifest / `.skill-cache` mode
   * detection) — neither exists for an injected/dispatched session, which
   * receives its context pre-loaded (see the `deterministic-load` step).
   * `stepsFor` drops these when called with `{ dispatched: true }`.
   */
  skillOnly?: boolean;
  /**
   * Per-skill override of `summary` for a skill where the shared prose does
   * not fit — e.g. a dispatched `ops` session has no synchronous chat turn
   * to wait within, so "present, then wait, then apply" (the groom/design
   * shape) inverts to "stage/request, then drive to applied-pending-confirm"
   * for ops.
   */
  summaryOverrides?: Partial<Record<SkillId, string>>;
  /**
   * Per-mode override of `title` for a step whose interactive framing
   * doesn't fit a dispatched session — e.g. "Present for sign-off" and
   * "Apply on sign-off" both name a synchronous chat wait that a dispatched
   * session never has (see `ExecutionMode`); the dispatched title names
   * what the step actually is for that session instead.
   */
  titleOverrides?: Partial<Record<ExecutionMode, string>>;
}

/** Resolve a step's summary against the given skill, honoring `summaryOverrides`. */
export function stepSummaryFor(step: ProcedureStep, skill: SkillId): string {
  return step.summaryOverrides?.[skill] ?? step.summary;
}

/** Resolve a step's title against the given execution mode, honoring `titleOverrides`. */
export function stepTitleFor(step: ProcedureStep, mode: ExecutionMode): string {
  return step.titleOverrides?.[mode] ?? step.title;
}

export const ORDERED_STEPS: readonly ProcedureStep[] = [
  {
    id: 'resolve-manifest-and-mode',
    title: 'Resolve manifest & mode',
    appliesTo: ['groom', 'design'],
    skillOnly: true,
    summary:
      'Read the grooming manifest from the central config tree, note ' +
      'architectural_control, determine the milestone, and determine fresh vs. ' +
      'resume mode from the on-disk cache dir.',
  },
  {
    id: 'deterministic-load',
    title: 'Deterministic load',
    appliesTo: ['groom', 'design', 'ops', 'split'],
    summary:
      'For an injected/dispatched session, the task context and worklist digest are ' +
      'already injected into this prompt — there is no loader to run and no ' +
      'device-authed client this session can authenticate as, so never attempt to ' +
      'fetch or reverse-engineer context by hand. A missing or empty digest is a ' +
      'blocked state to report (end the turn and surface it), not a cue to go ' +
      'looking for context yourself.',
  },
  {
    id: 'investigate',
    title: 'Investigate (cached, judgment where needed)',
    appliesTo: ['groom', 'design', 'ops', 'split'],
    summary:
      'Read the code / live data / architecture pages the open items actually turn ' +
      'on, once per region, keeping the reads in subagents so the main window stays ' +
      'small. The injected digest (resolved regions + verbatim task body) is ' +
      'authoritative for a dispatched session — verify scope by spot-checking the ' +
      'specific claims the decision actually turns on, not by re-deriving findings ' +
      'the digest already traced from git history or from scratch. When a ' +
      'spot-check contradicts the digest, that contradiction is itself a blocker ' +
      'to surface, never to wave away or quietly resolve around: keep the task at ' +
      'Backlog with a decisionProposal naming the contradicting finding, rather ' +
      'than proceeding on either the digest or the spot-check as if the conflict ' +
      'did not happen. This is a premise that needs re-investigation, not scope ' +
      'superseded by another task — Backlog, never Deferred, keeps it in the ' +
      'grooming queue instead of skipping it forever.',
  },
  {
    id: 'present-for-signoff',
    title: 'Present for sign-off',
    appliesTo: ['groom', 'design', 'ops', 'split'],
    titleOverrides: {
      dispatched: 'Present (stage — the terminal action)',
    },
    summary:
      'Present findings and a recommendation in batches (or one task/question at a ' +
      'time), and stop for explicit human sign-off before proceeding.',
    summaryOverrides: {
      split:
        '**Directive — staging is the terminal action:**\n' +
        '- DO stage the full split the moment the cut is decided (which acceptance ' +
        'criteria / files form each coherent subset) — never a partial or ' +
        'placeholder cut.\n' +
        '- DO NOT end the turn on a chat write-up or "here is the proposed split" ' +
        'summary — that is never a valid stopping point.\n' +
        '- DO NOT ask for sign-off before staging.\n\n' +
        'A dispatched split session has no synchronous chat turn to wait within — ' +
        'end the turn and it parks. So presenting IS staging: once the cut is ' +
        'decided, stage exactly the `composeSplitIntents` shape — one ' +
        '`task.updateBody` narrowing the original to the ONE subset it keeps (its ' +
        'ID never changes), one `task.create` per sibling subset (the N-1 subsets ' +
        'the original does not keep, landing at 🔲 Backlog), and a ' +
        '`task.setDependsOn` for any sibling that hard-blocks on another sibling or ' +
        'on the original — all under one shared `groupId`. Reference a ' +
        'not-yet-created sibling by its local ref as `$ref:<ref>`; it resolves to ' +
        "that sibling's real task id once its `task.create` is applied. Every " +
        'sibling (and the narrowed original) must be independently gradeable ' +
        'against its own acceptance criteria — never stage a cut that leaves an ' +
        'ambiguous or incomplete subset on either side.',
      ops:
        '**Directive — stage or request is the terminal action, then keep driving:**\n' +
        '- DO stage the next step the moment investigation reaches a decision — ' +
        'either the next legal ops_journal transition (`journal.setState` → the ' +
        'next state on the normal path — `candidate` before `staged-proposal` ' +
        'when leaving `pending`; see "ops_journal state machine" above), ' +
        'or, if applying it needs a capability this session lacks, a ' +
        '`session.requestCapability` naming the exact write.\n' +
        '- DO NOT ask in chat whether to stage or request first.\n' +
        '- DO end the turn immediately once staged/requested — that is what puts ' +
        'the decision in front of the operator; asking first leaves them nothing ' +
        'to act on.\n\n' +
        'A dispatched ops session has no synchronous chat turn to wait within — ' +
        'end the turn and it parks. So presenting IS staging, but for ops staging ' +
        'is the first move in a drive-to-applied loop, not a handoff: once ' +
        'investigation reaches a decision, stage the next legal ops_journal ' +
        'transition (`journal.setState` → the next state on the normal path — ' +
        '`candidate` before `staged-proposal` when leaving `pending`; see ' +
        '"ops_journal state machine" above), or, if applying it needs a ' +
        'capability this session lacks, stage a `session.requestCapability` ' +
        'naming the exact write. Never ask in chat whether to stage or request ' +
        'first — staging/requesting is what puts the decision in front of the ' +
        'operator; asking first leaves them with nothing to act on.',
      groom:
        '**Directive — staging is the terminal action:**\n' +
        '- DO stage the grooming decision (Ready or Deferred) as the last action ' +
        'of every turn that reaches a conclusion.\n' +
        '- DO NOT end the turn on a chat write-up, findings recap, or "plan ready ' +
        'to hand off" summary — none of those is a valid stopping point.\n' +
        '- DO NOT ask for sign-off before staging.\n' +
        '- MAY call ' +
        `\`${orchestratorMcpToolName('groom.precheck')}\`` +
        ' with the proposed `taskId` + `groomingGate` payload before staging the ' +
        'Ready path, to see the same violations `task.setStatus` would surface at ' +
        'stage time — including the binding-constraint set recomputed from the ' +
        'submitted `regions`, which can include a constraint the digest never ' +
        'showed once regions have been refined during investigation — without ' +
        'staging anything. Advisory only: a session confident its payload is ' +
        'already clean may skip straight to staging.\n\n' +
        'A dispatched groom session has no synchronous chat turn to wait within — ' +
        'end the turn and it parks. So presenting IS staging: once investigation ' +
        'reaches a grooming decision, stage it (task.setStatus / setProperties / ' +
        'setDependsOn to promote to 🗂️ Ready, or task.setStatus to Deferred with a ' +
        'decisionProposal) rather than writing up an investigation report in chat ' +
        'and asking whether to defer or groom to Ready. Never ask for sign-off ' +
        'before staging — staging is what puts the decision in front of the ' +
        'operator; asking first leaves the operator with nothing to act on. ' +
        'This is the terminal mandate, stated unambiguously: you are NOT finished ' +
        'once you have reached a conclusion — you are finished only once that ' +
        'conclusion exists as a staged intent. A "plan ready to hand off" chat ' +
        'write-up, a findings recap, or any other prose summary of the decision ' +
        'is never the deliverable and is never a valid place to end the turn; a ' +
        'session that ends there has produced nothing an operator can act on, ' +
        'no matter how correct its analysis was. The terminal intent set is ' +
        'exactly one of three paths, by intent kind: the Ready path stages ' +
        '`task.setStatus` (status: "Ready", carrying every `groomingGate` field) ' +
        '+ `task.setDependsOn` (always — the promotion gate requires it even ' +
        'when there are no dependencies, staged as an empty array) + ' +
        '`gate.accrete` + ' +
        '`seed.stage` (both required for every 💻 Code task — an explicit ' +
        '`{"decision":"none"}` when there is genuinely nothing to accrete, never ' +
        'a field left unstaged) + a `task.patchBodySection` (`operation: ' +
        '"remove"`) stripping the "### 👁️ Manual verification" section when the ' +
        'pre-groom body carries one (omitted entirely when it does not) — all ' +
        'under the same shared `groupId` as one grooming decision, never the ' +
        'body strip staged separately or ungrouped; the Deferred path stages a ' +
        'single ' +
        '`task.setStatus` (status: "Deferred") carrying a `decisionProposal` ' +
        'naming why; the third path, `planning.noOp`, is for the rare turn ' +
        'that reaches terminal with no task-write at all — not "the task is ' +
        'not ready" (that is Deferred, and always carries a `decisionProposal` ' +
        'against a specific gap) but "nothing about this task needs a decision ' +
        'right now" (e.g. a re-dispatch of an already-Ready task with nothing ' +
        'new to add). Stage `planning.noOp` (`{taskId, reason}`, one line ' +
        'naming why nothing changed) rather than ending the turn on a chat ' +
        'write-up or silently parking — a park with nothing staged is ' +
        'indistinguishable from a session that crashed mid-thought, while a ' +
        'staged no-op is an auditable, deliberate signal the operator can ' +
        'see and judge. Reach for Deferred whenever there is a real gap to ' +
        'name; reach for `planning.noOp` only when there genuinely is none. ' +
        'The promotion rule (distinct from the dispatch-satisfaction rule ' +
        'below) — this is what decides whether a dependency blocks the Ready ' +
        'path, and it is the dep gate\'s own behavior ' +
        '(`orchestration/planningCandidates.ts` `passesGroomDepGate`), stated ' +
        'here so a groom session applies it rather than reasoning about ' +
        'dependencies from first principles: a Depends-On of a ' +
        'decision-producing Type — 📐 Design / 📋 Planning / 🔎 Investigation — ' +
        'blocks promotion to Ready for as long as it is not ✅ Done. A ' +
        'Depends-On of any other Type, including 💻 Code, blocks promotion ' +
        'only while it sits at 🔲 Backlog or ⏭️ Deferred — once it has been ' +
        'groomed to 🗂️ Ready, or picked up (🔄 In Progress, 👀 In Review), it ' +
        'no longer blocks promotion. Promotion is not dispatch: staging the ' +
        'Ready path for a task with such a dependency does not skip ahead of ' +
        'it — the auto-dispatcher independently holds every Ready task until ' +
        'all of its dependencies reach ✅ Done, regardless of what this dep ' +
        'gate allowed at grooming time. A groom session must not withhold a ' +
        'promotion the dep gate would allow in order to additionally enforce ' +
        'that later, dispatch-time sequencing itself — that duplicates a rule ' +
        'the dispatcher already owns and leaves a groomable task stranded at ' +
        'Backlog. (This is separate from the Deferred-path warning below, ' +
        'which is about what a split leaves for a task\'s own dependents to ' +
        'satisfy — not about what blocks this task\'s own promotion.) ' +
        'When investigation concludes the task is simply too large — a coherent ' +
        'subset should be retained and the rest carved off — that is still the ' +
        'Ready path, not Deferred: stage a `task.updateBody` (or targeted ' +
        '`task.patchBodySection` operations) that narrows the original in place ' +
        'to exactly the retained scope (Summary, Context, acceptance criteria, ' +
        'and Files/paths all reduced to match), stage one `task.create` per ' +
        'excised piece (landing at 🔲 Backlog, each naming in its Context that ' +
        'it was split off this task and which part it carries) under the ' +
        'same shared `groupId` as the narrowing decision — a split/spin-off ' +
        '`task.create` is never staged ungrouped; it is dispositioned atomically ' +
        "with the narrowing it belongs to, exactly like the Ready path's other " +
        'grouped members above. Stage ' +
        '`task.setDependsOn` where the cut creates a genuine ordering ' +
        'constraint between the narrowed original and a sibling, then take the ' +
        'Ready path for the narrowed original as normal — it has been groomed, ' +
        "not abandoned. Recommend the narrowed original's body also carry a " +
        'short one-line note (e.g. in Context) naming the siblings it was ' +
        'split into, so the redistribution stays traceable from the surviving ' +
        'task. The Deferred path is for scope genuinely superseded or ' +
        'genuinely not ready — never for "I split this up"; a split that ends ' +
        "on Deferred silently blocks the original's dependents, since only " +
        '✅ Done satisfies a Depends On (config/procedures.md § Task types) ' +
        'and Deferred does not. Relatedly, a session that narrows in place ' +
        'must record `size_check.decision` as `no_split` — the retained ' +
        'scope, after narrowing, genuinely does not need further splitting — ' +
        'never `split_now`: `split_now` nominates the separate, untested ' +
        'split-session flow (`routes/groomFlip.ts` routing to ' +
        '`split/splitSession.ts`), which this in-place narrowing does not ' +
        'invoke, and recording it would divert the Ready flip into that ' +
        'routing and fail with a 409 instead of landing the narrowed task at ' +
        'Ready. ' +
        'See the Structured Output Contract below for the ' +
        'field-level format of every field in each — reaching the right ' +
        'conclusion and not staging it in full is the same failure as reaching ' +
        'no conclusion at all.',
      design:
        '**Directive — staging is the terminal action:**\n' +
        "- DO stage each Open Question's resolution, one at a time in the order " +
        'the task body lists them, as its own `decision.pickOne` intent (options = ' +
        'the candidate answers) — never a `task.updateBody` edit, and never two ' +
        'questions staged in the same turn. Hold a question whose answer depends ' +
        'on an as-yet-unresolved one, stating the dependency, rather than staging ' +
        'it.\n' +
        '- DO stage `task.updateBody` (the Implementation notes) exactly once, ' +
        'the last of the decision-recording steps — carrying the three-part ' +
        'authored synthesis (decision summary, open questions resolved, ' +
        'completeness-critic dispositions) as its `decisionProposal`, presented ' +
        'for the operator to approve, never a bare body-write diff to validate. ' +
        'Parts 4 and 5 (architecture pages updated, follow-on Code tasks filed) ' +
        'are generated at stage time from the staged terminal set — do not author ' +
        'them. ' +
        DESIGN_TERMINAL_ARTIFACTS_ORDERING +
        '\n' +
        '- DO stage the architecture-unit change(s) each locked decision implies, ' +
        'or a `planning.noOp` naming `skippedKind: "architecture"` when genuinely ' +
        'no page applies, and the follow-on `task.create` intents a locked design ' +
        'implies, or a `planning.noOp` naming `skippedKind: "task.create"` when ' +
        'nothing further is implied — both in this same pass, generated into the ' +
        'closing synthesis, never left for the operator to request afterward. The ' +
        'closing synthesis is refused at stage time until each is accounted for.\n' +
        '- DO NOT end the turn on a chat write-up, findings recap, or "here is ' +
        'what I think" summary — none of those is a valid stopping point. Staging ' +
        'the Implementation-notes write is not the end of the session either: it ' +
        'is not complete until the architecture and follow-on-task deliverables ' +
        'above are also staged or explicitly dispositioned as not applicable.\n' +
        '- DO NOT ask for sign-off before staging.\n\n' +
        'A dispatched design session has no synchronous chat turn to wait ' +
        'within — end the turn and it parks. So presenting IS staging: once ' +
        'investigation reaches a design decision or resolves an open question, ' +
        'stage it rather than writing up an investigation report in chat and ' +
        'asking whether to proceed. Never ask for sign-off before staging — ' +
        'staging is what puts the decision in front of the operator; asking ' +
        'first leaves the operator with nothing to act on. This is the terminal ' +
        'mandate, stated unambiguously: you are NOT finished once you have ' +
        'reached a conclusion — you are finished only once that conclusion ' +
        'exists as a staged intent. A "plan ready to hand off" chat write-up, a ' +
        'findings recap, or any other prose summary of the decision is never the ' +
        'deliverable and is never a valid place to end the turn; a session that ' +
        'ends there has produced nothing an operator can act on, no matter how ' +
        'correct its analysis was.',
    },
  },
  {
    id: 'incorporate-feedback',
    title: 'Incorporate feedback',
    appliesTo: ['groom', 'design'],
    summary:
      'Handle feedback one item at a time — stage the write, confirm in chat, ' +
      'continue. Never batch multiple decisions into one silent pass.',
    summaryOverrides: {
      design:
        'DO stage each Open Question’s resolution as its own `decision.pickOne` ' +
        'intent — never bundle two questions into one intent, and never stage a ' +
        'second question before the operator has disposed of the current one. DO ' +
        'handle the task body’s Open Questions one at a time, in the order they ' +
        'are written; hold a question whose answer depends on another ' +
        'still-unresolved question, stating the dependency, until that answer ' +
        'lands. DO NOT wait for a chat confirmation before ' +
        'continuing: a dispatched design session has no synchronous chat turn to ' +
        'wait within — the staged intent is the confirmation surface, and the ' +
        'operator (not this session) disposes it.',
    },
  },
  {
    id: 'accrete-gate-and-seed',
    title: 'Accrete gate & seed contribution',
    appliesTo: ['groom'],
    summary:
      'Accretion is author-proposes, groomer-validates — never relocation. The ' +
      'task body\'s pre-groom "### 👁️ Manual verification" section, when ' +
      "present, carries the author's advisory candidates — a hypothesis about " +
      'what will need observing, not an instruction, and not the input this ' +
      'step transcribes. Do the independent work first: read the code regions ' +
      "this task touches and assess the change's own runtime-observable " +
      'behaviour from that reading — what would only be knowable by running ' +
      'the system and looking, that the author may not have foreseen. Then ' +
      'engage with each author candidate on its substance, not on whether a ' +
      'line exists: accept it, correct it, or reject it with a reason, since ' +
      'the author may simply be wrong. Also add runtime verifications of its ' +
      'own that the change requires and the author did not foresee — the ' +
      'groomer is the party that has read the code regions, so it is better ' +
      'placed than the author to know what must be observed. Classify every ' +
      'candidate — author-' +
      'proposed or groomer-added — as one of three outcomes: `runtime-' +
      'observable` (only knowable by running the system and looking — accrete ' +
      'it as a gate item), `config-or-code-determined` (answerable from ' +
      'source, settings, or a unit test — never accrete it; relocate the line ' +
      'to the task\'s "### 🤖 Automated tests" section instead of dropping ' +
      'it), or `needs-triage` (genuinely unclear — accrete it flagged, as ' +
      'today). The deciding question: would a headless verifier be able to ' +
      'cite a behavioural trace for this, or only cite the code? If only the ' +
      "code, it is a test, not a gate item. Record every candidate's " +
      'classification in the `gate_contribution` artifact — the check enforced ' +
      'is that a classification was recorded for each candidate, never a ' +
      'judgment on which classification was chosen. The count of candidates in ' +
      'must equal the count accreted plus the count relocated — disposition ' +
      'every candidate, never silently drop one. ' +
      'Then stage its gate_contribution (`gate.accrete`) and seed_contribution ' +
      "(`seed.stage`) — either the task's real runtime-gate items / " +
      'config-change seeds (from the assessment above, not only from what the ' +
      'author happened to write), or an explicit `{"decision":"none"}` when ' +
      'the assessment genuinely finds nothing runtime-observable. ' +
      '`{"decision":"none"}` remains fully legitimate — do not invent a fake ' +
      'gate item to avoid it, since a padded gate is worse than an empty one: ' +
      'it burns operator attention at milestone end on checks that verify ' +
      'nothing — but it must be a judgment, not a byproduct of an ' +
      'empty input section: `gate.accrete` requires a substantive `reason` ' +
      'alongside a bare `none`/`n/a` classification, stating what about the ' +
      "change's behaviour was assessed and found to have nothing gate-worthy " +
      '(tied to the change, never to the state of the body section — "the ' +
      'section was empty" is not a reason). Both are durable markers ' +
      'checkGroomingPromotionGate requires for ' +
      'every 💻 Code task; a Ready flip staged without them is blocked at commit ' +
      'time and surfaced back at stage time — never stage the Ready flip first ' +
      'and leave accretion for later. Once accreted (and any ' +
      'config-or-code-determined lines relocated to "### 🤖 Automated tests"), ' +
      'stage a `task.patchBodySection` with `operation: "remove"` targeting the ' +
      '"### 👁️ Manual verification" heading — never a whole-body ' +
      '`task.updateBody` for this strip: removing one section is exactly what ' +
      "`task.patchBodySection`'s remove operation exists for, and re-rendering " +
      'the entire body to delete one section is both needless collision surface ' +
      'and a diff the operator cannot review at a glance. The section must still ' +
      'be removed entirely — never left behind, and never replaced with ' +
      'boilerplate ("Covered by the Manual Verification Gate."). A post-groom ' +
      '💻 Code task carries no manual-verification section at all; that absence ' +
      'is the intended post-groom state, not a gap to fill back in. A task ' +
      'whose pre-groom body carries no "### 👁️ Manual verification" section ' +
      'stages no strip intent at all — an absent section needs no removal, and ' +
      'never stage an empty/no-op patch to manufacture one. DO stage this ' +
      "`task.patchBodySection` under the same `groupId` as the Ready path's " +
      '`gate.accrete` / `seed.stage` / `task.setDependsOn` / `task.setStatus` ' +
      'intents — the strip is part of the same grooming decision those carry, ' +
      'never a standalone ungrouped write the operator must disposition on its ' +
      'own, disconnected from the proposal that explains it. This targets the ' +
      "accretion strip specifically: a groom that genuinely rewrites a task's " +
      'whole body (restructuring its spec) still uses `task.updateBody` as ' +
      'usual — that primitive is not disallowed, only wrong for a single-' +
      'section removal.',
  },
  {
    id: 'file-follow-on-tasks',
    title: 'File follow-on tasks',
    appliesTo: ['groom', 'design', 'ops'],
    summary:
      "When the mandate calls for follow-on work — an Investigation's decision plus " +
      'filed follow-on tasks, a /design "🔲 Backlog" split, or a /groom split-off — ' +
      'stage each one as a `task.create` intent (landing at 🔲 Backlog) rather than ' +
      'describing the task spec in chat for the operator to create by hand. The ' +
      'operator disposes the staged task like any other intent; never treat handing ' +
      'a task spec back in chat as an acceptable substitute for staging it.',
    summaryOverrides: {
      design:
        'A locked design implies follow-on work far more often than it implies a ' +
        'split — stage the implementation work every locked design implies as ' +
        '`task.create` intents (landing at 🔲 Backlog, typed 💻 Code) in the same ' +
        "pass, not only in the '🔲 Backlog' split-overflow case. Do this for every " +
        'Design task, not just one that overflows into a sibling: when the locked ' +
        'decisions imply no implementation work beyond themselves, stage a ' +
        '`planning.noOp` naming `skippedKind: "task.create"` rather than leaving ' +
        'the deliverable unaddressed — the closing synthesis is refused at stage ' +
        'time until this is staged or the follow-on task itself is. The operator ' +
        'disposes ' +
        'each staged task like any other intent; never treat handing a task spec ' +
        'back in chat as an acceptable substitute for staging it. ' +
        DESIGN_TERMINAL_ARTIFACTS_ORDERING,
      ops:
        'When the mandate calls for follow-on work — including an operational ' +
        'change that turns out to need a code change — stage it as a ' +
        '`task.create` intent (landing at 🔲 Backlog, typed 💻 Code) carrying the ' +
        'spec, rather than describing it in chat. This session has no worktree or ' +
        'branch and must never create a PR or author code directly: a code ' +
        'change is categorically routed through a staged 💻 Code task, never ' +
        'applied by ops itself — stage the task and continue driving the rest of ' +
        'the operational change (or park on it if the whole thing is now blocked ' +
        'on that Code task landing).',
    },
  },
  {
    id: 'apply-on-signoff',
    title: 'Apply on sign-off',
    appliesTo: ['groom', 'design', 'ops', 'split'],
    titleOverrides: {
      dispatched: 'Apply (operator/device-auth only)',
    },
    summary:
      'Only after explicit sign-off, stage and apply the write through the ' +
      'sanctioned surface, and confirm the result in chat.',
    summaryOverrides: {
      groom:
        'A dispatched groom session never applies a write itself — it only ' +
        'stages. The staged intent set (task.setStatus / setProperties / ' +
        'setDependsOn for the Ready path, task.setStatus for the Deferred ' +
        'path, or planning.noOp for the no-decision-needed path) is the ' +
        'terminal action; the operator applies the Ready/Deferred paths from ' +
        'the shared staged-intent display, while a `planning.noOp` needs no ' +
        'operator disposition at all — it is informational/auditable, ' +
        'rendered so the operator can see the turn was a deliberate no-op ' +
        'rather than a silent park. DO NOT drive the write to applied or ' +
        'wait in chat for confirmation of an applied result. DO end the ' +
        'turn the moment it is staged.',
      split:
        'A dispatched split session never applies a write itself — it only ' +
        'stages the narrowed-original `task.updateBody`, the sibling ' +
        '`task.create` intents, and any intra-split `task.setDependsOn`, for the ' +
        'operator to apply from the shared staged-intent display. DO end the ' +
        'turn the moment the full split is staged — that is the terminal action, ' +
        'not a chat confirmation of an applied result.',
      ops:
        'A dispatched ops session drives the change itself once a capability is ' +
        'granted or a staged-proposal is approved: apply the write, reconcile and ' +
        'capture evidence of the result, and advance the ops_journal — then ' +
        'repeat the request → grant → apply → reconcile loop, one atomic action ' +
        'at a time, until the journal reaches `applied-pending-confirm`, or park ' +
        'because you are genuinely blocked on the next operator decision (a ' +
        'pending capability grant, or a step only a human can perform, like ' +
        'secret provisioning). The one transition this session never makes ' +
        'itself is `applied-pending-confirm` → `resolved` — that confirmation is ' +
        'device-auth/operator-only, always.',
      design:
        'A dispatched design session never applies a write itself — it only ' +
        'stages. DO stage `task.updateBody` (the Implementation notes) exactly ' +
        'once, the last of the decision-recording steps — carrying the ' +
        'three-part authored synthesis as its `decisionProposal` (see "Closing ' +
        'synthesis" below); parts 4 and 5 are generated at stage time, not ' +
        'authored. The operator is approving that synthesis, not ' +
        'diffing the body write — presenting IS staging, so the synthesis rides ' +
        'on the same intent the body write does, rather than a separate ' +
        "validation step. This write is not the pass's terminal action: the " +
        'architecture-unit updates and follow-on `task.create` intents the ' +
        'locked decisions imply (or a `planning.noOp` naming the skipped kind, ' +
        'for either) are staged in ' +
        'this same pass and reported in that synthesis. ' +
        DESIGN_TERMINAL_ARTIFACTS_ORDERING +
        ' DO NOT drive any of ' +
        'these writes to applied or wait in chat for confirmation of an applied ' +
        'result; the operator applies the staged intents. DO end the turn ' +
        'once every deliverable — decisions, architecture pages, follow-on ' +
        'tasks — is staged or explicitly dispositioned as not applicable, not at ' +
        'the Implementation-notes write alone.',
    },
  },
] as const;

export function stepsFor(
  skill: SkillId,
  context: { dispatched?: boolean } = {},
): ProcedureStep[] {
  return ORDERED_STEPS.filter(
    (s) => s.appliesTo.includes(skill) && !(context.dispatched && s.skillOnly),
  );
}

/**
 * The readiness bar a Backlog/Design task must clear before a skill session
 * proposes flipping it forward. The deterministic seeds are real, enforced
 * code (see `implementedBy`); the human sign-off is what actually decides.
 */
export const READINESS_BAR = {
  description:
    'A task is Ready only once every open question is resolved or explicitly ' +
    'owned, scope is verified against the actual code, and tests + manual-gate ' +
    'items are enumerated. The structural/lexical checks below run ahead of time ' +
    'as seeds for the groomer — they are advisory input, not the enforcement point; ' +
    'the human sign-off recorded in state (`signoff: { by, at }`) is the actual bar.',
  implementedBy: 'packages/backend/src/tasks/readinessGate.ts',
} as const;

/**
 * Size/type validation — the deterministic seeds behind /groom's `size_check`
 * and `type_check`, both required fields on the Ready-transition promotion
 * gate (`checkGroomingPromotionGate` in `groomGate.ts`).
 */
export const SIZE_TYPE_CHECK = {
  locSplitThreshold: 500,
  fileSplitThreshold: 20,
  description:
    'Code/Tooling tasks default to < 500 LoC estimated and < 20 files touched; ' +
    'exceeding either threshold nominates the task for a split — the threshold ' +
    'nominates, it does not force, and `unsplittable` with a recorded reason ' +
    "remains a legitimate outcome above either one. Where a task's files cluster " +
    'into distinct root-causes, the file-count signal should read as a nomination ' +
    'to split along those clusters rather than a flat count. Design/Planning ' +
    'tasks are sized in open-question count instead, recorded as ' +
    '`{decision: "n/a"}`. type_check is an advisory keyword/heuristic scan for a ' +
    'task body whose content does not match its declared Type ("smuggling") — it ' +
    'never hard-blocks; the groomer records a disposition.',
  implementedBy: [
    'packages/backend/src/groom/groomLoad.ts (sizeCheckSeed)',
    'packages/backend/src/groom/typeCheck.ts',
  ],
} as const;
