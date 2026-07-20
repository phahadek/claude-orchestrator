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
 */

export type SkillId = 'groom' | 'design' | 'ops';

export const SKILL_LABELS: Record<SkillId, string> = {
  groom: 'Grooming',
  design: 'Design Execution',
  ops: 'ops',
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
    appliesTo: ['groom', 'design', 'ops'],
    text:
      'Load project and task context through the sanctioned deterministic loader ' +
      '(a backend route, or a vendored script that wraps one) before any judgment ' +
      'step. Hand-fetching context pages or task bodies yourself is exactly the step ' +
      'that gets skipped under context pressure — never do it.',
  },
  {
    id: 'human-is-gate',
    title: 'The human is the gate',
    appliesTo: ['groom', 'design', 'ops'],
    text:
      'Every state-changing decision — a status flip, a locked design decision, an ' +
      'applied operational change — waits for explicit human (operator) sign-off. ' +
      '{skillLabel} proposes; it never self-authorizes the commit.',
  },
  {
    id: 'no-silent-writes',
    title: 'No silent writes',
    appliesTo: ['groom', 'design', 'ops'],
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
      'interactive — hand those to an operator-present run instead of dispatching them.',
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
}

export const ORDERED_STEPS: readonly ProcedureStep[] = [
  {
    id: 'resolve-manifest-and-mode',
    title: 'Resolve manifest & mode',
    appliesTo: ['groom', 'design'],
    summary:
      'Read the grooming manifest from the central config tree, note ' +
      'architectural_control, determine the milestone, and determine fresh vs. ' +
      'resume mode from the on-disk cache dir.',
  },
  {
    id: 'deterministic-load',
    title: 'Deterministic load',
    appliesTo: ['groom', 'design', 'ops'],
    summary:
      'Load context and the task worklist through the sanctioned loader — never by ' +
      'hand. Stop and report on a non-zero exit; a partial load must never silently ' +
      'become a skipped load.',
  },
  {
    id: 'investigate',
    title: 'Investigate (cached, judgment where needed)',
    appliesTo: ['groom', 'design', 'ops'],
    summary:
      'Read the code / live data / architecture pages the open items actually turn ' +
      'on, once per region, keeping the reads in subagents so the main window stays ' +
      'small.',
  },
  {
    id: 'present-for-signoff',
    title: 'Present for sign-off',
    appliesTo: ['groom', 'design', 'ops'],
    summary:
      'Present findings and a recommendation in batches (or one task/question at a ' +
      'time), and stop for explicit human sign-off before proceeding.',
  },
  {
    id: 'incorporate-feedback',
    title: 'Incorporate feedback',
    appliesTo: ['groom', 'design'],
    summary:
      'Handle feedback one item at a time — stage the write, confirm in chat, ' +
      'continue. Never batch multiple decisions into one silent pass.',
  },
  {
    id: 'apply-on-signoff',
    title: 'Apply on sign-off',
    appliesTo: ['groom', 'design', 'ops'],
    summary:
      'Only after explicit sign-off, stage and apply the write through the ' +
      'sanctioned surface, and confirm the result in chat.',
  },
] as const;

export function stepsFor(skill: SkillId): ProcedureStep[] {
  return ORDERED_STEPS.filter((s) => s.appliesTo.includes(skill));
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
