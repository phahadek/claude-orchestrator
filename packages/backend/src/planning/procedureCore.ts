/**
 * Canonical planning-procedure module — the shared domain core behind the
 * /groom, /design, and /ops skills.
 *
 * Today only one consumer exists: the interactive SKILL.md files, which
 * compose it by linking to `skills/_shared/reference/hard-rules.md` (kept in
 * lockstep with `renderHardRulesMarkdown` below — see
 * `procedureCore.test.ts`) instead of restating the cross-cutting rules
 * per-skill. A future injected assembler (present-and-wait replaced with
 * stage-output) is meant to import this same module rather than re-derive
 * the procedure from the vendored SKILL.md prose — that is the drift this
 * module exists to confine to thin execution-mode wrappers.
 *
 * Style: every load-bearing directive added here (a principle `text`, a
 * step `summary`/`summaryOverrides`) follows
 * `packages/backend/src/planning/INJECTED_PROCEDURE_STYLE.md` — terse,
 * imperative DO / DO NOT bullets, IS / IS-NOT lists for load-bearing
 * definitions. Read that file before editing this one.
 */

import { orchestratorMcpToolName } from '../mcp/toolNaming';

export type SkillId = 'groom' | 'design' | 'ops' | 'split';

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
 * ordered artifacts: `design-no-question-bundling`, the `present-for-signoff`
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
  'completeness critic has run. This orders artifacts behind answers, never ' +
  'questions behind each other: independent Open Questions still stage in ' +
  'the same turn (see "No question-bundling" above). EXEMPT: a file-sibling ' +
  "`task.create` (the Split-don't-trim overflow disposition) scopes the " +
  'work rather than following from a locked decision, and may be staged ' +
  'before Open Questions resolve.';

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
      'abstain, never invent.',
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
        'a denial — ask or abstain, never invent.',
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
        'a denial — ask or abstain, never invent.',
    },
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
      "fork) — see 'No question-bundling' below. A listed Open Question is never routed " +
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
    id: 'design-no-question-bundling',
    title:
      'No question-bundling — one Open Question per decision.pickOne intent',
    appliesTo: ['design'],
    text:
      "DO stage exactly one Open Question's resolution per `decision.pickOne` " +
      'intent (options = the candidate answers — a single option is a confident ' +
      'recommendation the operator accepts or pushes back on, not just a genuine ' +
      'fork), never a `task.updateBody` edit, and never two questions bundled into ' +
      'one intent. DO investigate before deciding — cite the code read, arch-page ' +
      'section, or API-call result the resolution rests on; "decide at ' +
      'implementation time" is a _defer_, never a _resolve_. DO stage every Open ' +
      'Question whose answer is independent of the others in the same turn, each as ' +
      'its own `decision.pickOne` intent — independent questions do not need to wait ' +
      'for separate round-trips. DO hold a question whose answer depends on another ' +
      'still-unresolved question, staging it once that answer lands, rather than ' +
      'staging both together — and DO treat independence conservatively: when unsure ' +
      'whether one answer constrains another, hold the dependent question rather ' +
      'than stage both; an operator dispositioning two questions whose answers turn ' +
      'out coupled is worse than one extra round-trip. DO NOT bundle multiple ' +
      'questions into one `decision.pickOne` intent. `task.updateBody` (the ' +
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
      'decision.pickOne payload shape mirrors the skill’s 5-part presentation',
    appliesTo: ['design'],
    text:
      'DO shape every Open Question’s `decision.pickOne` payload to carry the ' +
      'same contract `skills/design/reference/presentation.md`’s 5-part question ' +
      'message specifies for the interactive skill, mapped onto the payload’s ' +
      'fields (`prompt`, `options[]`, `decisionProposal`) rather than a second, ' +
      'drifting restatement of that contract. `prompt` carries the question alone ' +
      '— quote it concisely; DO NOT restate the candidate answers inline, those ' +
      'belong in `options`. DO stage one `options[]` entry per candidate solution ' +
      'considered, including a candidate {skillLabel} recommends against — DO NOT ' +
      'omit a rejected candidate because it lost, and DO NOT fold its rationale into ' +
      'a competing option’s description. DO write each option’s `description` as ' +
      'a self-contained, architecture-level statement of that one candidate plus its ' +
      'own trade-offs — DO NOT let it carry another option’s rationale, and DO NOT ' +
      'concatenate every candidate’s analysis into a single option’s field. DO carry ' +
      'evidence — file:line citations, arch-page section names, API-result specifics ' +
      '— in `decisionProposal`’s investigation summary rather than inside an option ' +
      'description; presentation.md’s evidence requirement still applies, this only ' +
      'relocates where it is carried, since the payload has no separate Investigation ' +
      'field. DO name the preferred solution and its load-bearing reason explicitly in ' +
      '`decisionProposal`, alongside that investigation summary. A single `options` ' +
      'entry stays valid — a confident recommendation the operator accepts or pushes ' +
      'back on (see ‘No question-bundling’ above) — this shape governs how it, or each ' +
      'of several, is written, never whether more than one is required.',
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
      '(`POST /api/design/:taskId/trace-coverage`) as an aid, never a gate: no ' +
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
      'DO dispose every candidate the completeness critic raises with a recorded ' +
      'reason — one of `resolved` / `out-of-scope` / `not-a-decision` / `fold` / ' +
      "`file-sibling` / `sibling-owned` — folded into the API's accepted/dismissed " +
      'disposition (`resolved` is `accepted`; the rest are `dismissed` carrying that ' +
      'reason). DO call `POST /api/design/:taskId/completeness-disposition` with ' +
      '`{questions: [{question, disposition: "accepted"|"dismissed", reason, ' +
      'approvalStatus: "proposed"}], runAt}` at critic time, for every critic run — ' +
      'this durable store, never body prose, is the record, and it is written ' +
      'immediately so nothing is silently lost even before the operator has seen ' +
      'it. DO NOT drop a candidate silently. DO NOT record a disposition only as ' +
      'Implementation-notes prose; prose may summarize it, but the store call is ' +
      'the disposition. DO NOT confuse "recorded" with "approved": a `proposed` ' +
      'disposition is provisional until the operator signs off on the closing ' +
      'synthesis carrying it — a pushback there re-POSTs the affected question ' +
      'with a revised disposition/reason rather than treating the first write as ' +
      'final.',
  },
  {
    id: 'design-closing-synthesis',
    title: 'Closing synthesis — the terminal decisionProposal, not a body diff',
    appliesTo: ['design'],
    text:
      'DO carry the exact five-part closing synthesis `skills/design/reference/' +
      'presentation.md` specifies as the `decisionProposal` of the ' +
      '`task.updateBody` intent: (1) Decision summary — one paragraph on what was ' +
      'decided and why; (2) Open questions resolved — a table, one row per listed ' +
      'Open Question, included only when there are ≥2 questions; (3) Completeness-' +
      'critic dispositions — every gap the pass raised, its disposition, and the ' +
      'run date, or "none — pass run, no gaps" when clean; (4) Architecture pages ' +
      'updated — each architecture unit and the section changed in this same pass, ' +
      'or "none — these decisions change no architecture page" when genuinely ' +
      'nothing applies; (5) Follow-on Code tasks filed — each staged as a ' +
      '`task.create` intent in this same pass, with Type and a one-line scope, or ' +
      '"none — no implementation work beyond the locked decisions" when nothing ' +
      'further is implied. DO frame the operator’s decision as approving ' +
      'this synthesis — the body write is its consequence, not a separate thing to ' +
      'diff. DO NOT ask the operator to validate the `task.updateBody` payload’s ' +
      'prose as if reviewing a diff; the synthesis is the reviewable artifact, ' +
      'carried in `decisionProposal`, not the body text itself. DO NOT fold the ' +
      'decision summary straight into the write without the other four parts — all ' +
      'five sections are required every time, per the skill’s hard checkpoint. DO ' +
      'NOT report parts 4 or 5 as "pending" or "see next messages" — by the time ' +
      'the closing synthesis stages, the architecture-unit intents and follow-on ' +
      '`task.create` intents it reports are already staged (or the "none" ' +
      'disposition is genuine); the synthesis reports what was done in this pass, ' +
      'never a promise of what comes next.',
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
      'work files that work now. DO state explicitly, for either deliverable, when ' +
      'the locked decisions genuinely touch no architecture page or spawn no ' +
      'follow-on task — silence is never an acceptable substitute for that ' +
      'statement, mirroring the disposition-don’t-drop rule the completeness ' +
      'critic follows above. DO NOT treat either statement as a numeric gate: there ' +
      'is no minimum count of architecture units or follow-on tasks, and neither is ' +
      'wired into a promotion block — this is an advisory-but-required reporting ' +
      'obligation, the same posture the trace-coverage signal already takes, not a ' +
      'size or count threshold.',
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
        'either the ops_journal transition (`journal.setState` → staged-proposal), ' +
        'or, if applying it needs a capability this session lacks, a ' +
        '`session.requestCapability` naming the exact write.\n' +
        '- DO NOT ask in chat whether to stage or request first.\n' +
        '- DO end the turn immediately once staged/requested — that is what puts ' +
        'the decision in front of the operator; asking first leaves them nothing ' +
        'to act on.\n\n' +
        'A dispatched ops session has no synchronous chat turn to wait within — ' +
        'end the turn and it parks. So presenting IS staging, but for ops staging ' +
        'is the first move in a drive-to-applied loop, not a handoff: once ' +
        'investigation reaches a decision, stage the ops_journal transition ' +
        '(`journal.setState` → staged-proposal), or, if applying it needs a ' +
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
        '- DO NOT ask for sign-off before staging.\n\n' +
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
        'exactly one of two paths, by intent kind: the Ready path stages ' +
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
        'naming why. See the Structured Output Contract below for the ' +
        'field-level format of every field in each — reaching the right ' +
        'conclusion and not staging it in full is the same failure as reaching ' +
        'no conclusion at all.',
      design:
        '**Directive — staging is the terminal action:**\n' +
        "- DO stage each Open Question's resolution, the moment it is reached, as " +
        'its own `decision.pickOne` intent (options = the candidate answers) — ' +
        'never a `task.updateBody` edit. Independent questions may be staged ' +
        'together; hold a question whose answer depends on an as-yet-unresolved ' +
        'one.\n' +
        '- DO stage `task.updateBody` (the Implementation notes) exactly once, ' +
        'the last of the decision-recording steps — carrying the five-part ' +
        'closing synthesis (decision summary, open questions resolved, ' +
        'completeness-critic dispositions, architecture pages updated, follow-on ' +
        'Code tasks filed) as its `decisionProposal`, presented for the operator ' +
        'to approve, never a bare body-write diff to validate. ' +
        DESIGN_TERMINAL_ARTIFACTS_ORDERING +
        '\n' +
        '- DO stage the architecture-unit change(s) each locked decision implies, ' +
        'or an explicit "none" statement when genuinely no page applies, and the ' +
        'follow-on `task.create` intents a locked design implies, or an explicit ' +
        '"none" statement when nothing further is implied — both in this same ' +
        'pass, reported in the closing synthesis, never left for the operator to ' +
        'request afterward.\n' +
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
        'intent — never bundle two questions into one intent. DO stage every ' +
        'independent Open Question in the same turn, each as its own intent; hold ' +
        'a question whose answer depends on another still-unresolved question ' +
        'until that answer lands. DO NOT wait for a chat confirmation before ' +
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
      'The accretion source is the task body\'s pre-groom "### 👁️ Manual ' +
      'verification" section, when present — its lines are candidates for ' +
      '`gate.accrete`, never a wholesale transcription target. Before staging ' +
      'anything, triage every candidate line and classify it as one of three ' +
      'outcomes: `runtime-observable` (only knowable by running the system and ' +
      'looking — accrete it as a gate item), `config-or-code-determined` ' +
      '(answerable from source, settings, or a unit test — never accrete it; ' +
      'relocate the line to the task\'s "### 🤖 Automated tests" section instead ' +
      'of dropping it), or `needs-triage` (genuinely unclear — accrete it ' +
      'flagged, as today). The deciding question: would a headless verifier be ' +
      'able to cite a behavioural trace for this, or only cite the code? If only ' +
      "the code, it is a test, not a gate item. Record every candidate's " +
      'classification in the `gate_contribution` artifact — the check enforced ' +
      'is that a classification was recorded for each candidate, never a ' +
      'judgment on which classification was chosen. The count of candidates in ' +
      'must equal the count accreted plus the count relocated — disposition ' +
      'every candidate, never silently drop one. ' +
      'Then stage its gate_contribution (`gate.accrete`) and seed_contribution ' +
      "(`seed.stage`) — either the task's real runtime-gate items / " +
      'config-change seeds, or an explicit `{"decision":"none"}` when it has ' +
      'none. Both are durable markers checkGroomingPromotionGate requires for ' +
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
        'decisions imply no implementation work beyond themselves, state that ' +
        'explicitly ("none — no implementation work beyond the locked decisions") ' +
        'rather than leaving the deliverable unaddressed. The operator disposes ' +
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
        'setDependsOn for the Ready path, or task.setStatus for the Deferred ' +
        'path) is the terminal action; the operator applies it from the shared ' +
        'staged-intent display. DO NOT drive the write to applied or wait in ' +
        'chat for confirmation of an applied result. DO end the turn the ' +
        'moment it is staged.',
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
        'five-part closing synthesis as its `decisionProposal` (see "Closing ' +
        'synthesis" below). The operator is approving that synthesis, not ' +
        'diffing the body write — presenting IS staging, so the synthesis rides ' +
        'on the same intent the body write does, rather than a separate ' +
        "validation step. This write is not the pass's terminal action: the " +
        'architecture-unit updates and follow-on `task.create` intents the ' +
        'locked decisions imply (or an explicit "none" for either) are staged in ' +
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
  description:
    'Code/Tooling tasks default to < 500 LoC estimated; larger tasks split unless ' +
    'demonstrably unsplittable. Design/Planning tasks are sized in open-question ' +
    'count instead, recorded as `{decision: "n/a"}`. type_check is an advisory ' +
    'keyword/heuristic scan for a task body whose content does not match its ' +
    'declared Type ("smuggling") — it never hard-blocks; the groomer records a ' +
    'disposition.',
  implementedBy: [
    'packages/backend/src/groom/groomLoad.ts (sizeCheckSeed)',
    'packages/backend/src/groom/typeCheck.ts',
  ],
} as const;
