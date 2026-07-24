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
}

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
    appliesTo: ['ops'],
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
      '🔲 Backlog. (📋 Planning and 📐 Design tasks are exempt from this check on their ' +
      "own open-question-space — see `readinessGate.ts`'s " +
      '`OPEN_QUESTIONS_EXEMPT_TYPES` — because for those types the open questions ' +
      'are the deliverable being scoped, not a precondition being dodged.)',
  },
  {
    id: 'decision-pickone-genuine-forks-only',
    title: 'decision.pickOne is for genuine forks only',
    appliesTo: ['groom', 'design', 'ops'],
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
    id: 'design-no-batch-locking',
    title: 'No batch-locking — one Open Question at a time',
    appliesTo: ['design'],
    text:
      "DO stage exactly one Open Question's resolution per `decision.pickOne` " +
      'intent (options = the candidate answers), never a `task.updateBody` edit, and ' +
      "never more than one question's resolution staged per turn. DO investigate " +
      'before deciding — cite the code read, arch-page section, or API-call result the ' +
      'resolution rests on; "decide at implementation time" is a _defer_, never a ' +
      '_resolve_. DO hold a question whose answer depends on another still-unresolved ' +
      'question rather than staging both together. DO NOT batch-lock multiple ' +
      'questions into one pass. `task.updateBody` (the Implementation notes) is staged ' +
      'exactly once, as the final step, only after every question is settled and the ' +
      'completeness critic below has run.',
  },
  {
    id: 'design-completeness-critic',
    title: 'Completeness critic — once per task, before Implementation notes',
    appliesTo: ['design'],
    text:
      'DO run the completeness critic exactly once per Design task, after every ' +
      'listed Open Question is locked and before staging the final ' +
      '`task.updateBody` (Implementation notes). DO probe the recurring gap ' +
      'classes — a decision the implementer needs that no locked question ' +
      'covers — consuming the advisory trace-coverage signal ' +
      '(`POST /api/design/:taskId/trace-coverage`) as an aid, never a gate: no ' +
      'locked-decision-count threshold, no promotion block. DO NOT skip the critic ' +
      'pass because every listed question already locked cleanly — the pass exists ' +
      'to surface gaps no question named.',
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
      '`{questions: [{question, disposition: "accepted"|"dismissed", reason}], ' +
      'runAt}` for every critic run — this durable store, never body prose, is the ' +
      'record. DO NOT drop a candidate silently. DO NOT record a disposition only as ' +
      'Implementation-notes prose; prose may summarize it, but the store call is the ' +
      'disposition.',
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
  return p.text.replace(/\{skillLabel\}/g, SKILL_LABELS[skill]);
}

export function principlesFor(skill: SkillId): ProcedurePrinciple[] {
  return CORE_PRINCIPLES.filter((p) => p.appliesTo.includes(skill));
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
}

/** Resolve a step's summary against the given skill, honoring `summaryOverrides`. */
export function stepSummaryFor(step: ProcedureStep, skill: SkillId): string {
  return step.summaryOverrides?.[skill] ?? step.summary;
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
      'the digest already traced from git history or from scratch.',
  },
  {
    id: 'present-for-signoff',
    title: 'Present for sign-off',
    appliesTo: ['groom', 'design', 'ops', 'split'],
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
        "not-yet-created sibling by its local ref as `$ref:<ref>`; it resolves to " +
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
        '+ `task.setDependsOn` (when dependencies were found) + `gate.accrete` + ' +
        '`seed.stage` (both required for every 💻 Code task — an explicit ' +
        '`{"decision":"none"}` when there is genuinely nothing to accrete, never ' +
        'a field left unstaged); the Deferred path stages a single ' +
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
        '- DO stage `task.updateBody` (the Implementation notes) exactly once, as ' +
        'the final step, only after every question is settled and the ' +
        'completeness critic has run.\n' +
        '- DO NOT end the turn on a chat write-up, findings recap, or "here is ' +
        'what I think" summary — none of those is a valid stopping point.\n' +
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
        'DO handle each Open Question one at a time — stage its resolution as a ' +
        '`decision.pickOne` intent, then end the turn. DO NOT wait for a chat ' +
        'confirmation before continuing: a dispatched design session has no ' +
        'synchronous chat turn to wait within — ' +
        'the staged intent is the confirmation surface, and the operator (not this ' +
        "session) disposes it. DO NOT batch multiple questions' resolutions into " +
        'one pass.',
    },
  },
  {
    id: 'accrete-gate-and-seed',
    title: 'Accrete gate & seed contribution',
    appliesTo: ['groom'],
    summary:
      'Before staging `task.setStatus` → Ready for a 💻 Code task, stage its ' +
      'gate_contribution (`gate.accrete`) and seed_contribution (`seed.stage`) — ' +
      "either the task's real runtime-gate items / config-change seeds, or an " +
      'explicit `{"decision":"none"}` when it has none. Both are durable markers ' +
      'checkGroomingPromotionGate requires for every 💻 Code task; a Ready flip ' +
      'staged without them is blocked at commit time and surfaced back at stage ' +
      'time — never stage the Ready flip first and leave accretion for later.',
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
    summary:
      'Only after explicit sign-off, stage and apply the write through the ' +
      'sanctioned surface, and confirm the result in chat.',
    summaryOverrides: {
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
        'once, as the final step, after every Open Question is locked and the ' +
        'completeness critic has run — carrying a `decisionProposal` summarizing ' +
        'the locked decisions. DO NOT drive the write to applied or wait in chat ' +
        'for confirmation of an applied result; the operator applies the staged ' +
        'intent. DO end the turn ' +
        'the moment it is staged — that is the terminal action, not a chat ' +
        'confirmation.',
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
