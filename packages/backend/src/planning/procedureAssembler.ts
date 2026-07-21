/**
 * Injected planning-procedure assembler — the single composable builder
 * behind a dispatched planning session's appended-prompt file, mirroring
 * buildOrchestratorClaudeMd's single-builder-with-branches pattern (see
 * `session/orchestrator-claudemd.ts`) but for the stage-then-human-apply
 * (groom/design/ops) execution mode instead of the code-dispatch one.
 *
 * Composition (three slots, always in this order):
 *
 *   1. Skeleton (written once, shared by every workflow): session lifecycle,
 *      the stage-only transport, and the structured output contract (staged
 *      intents + the decision-proposal annotation).
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
  type SkillId,
} from './procedureCore';
import type { GroomLoadResult } from '../groom/groomLoad';
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

/** Narrow a full `loadGroomContext` result to the one target task's validation slice. */
export function deriveGroomDigestSlice(
  result: GroomLoadResult,
  taskId: string,
): GroomDigestSlice {
  const doc = result.targetTasks.find((t) => normId(t.id) === normId(taskId));
  if (!doc) {
    throw new Error(
      `procedureAssembler: task ${taskId} not found in groom target tasks`,
    );
  }
  const dependencyCandidates =
    result.dependencyCandidates.find(
      (c) => normId(c.taskId) === normId(taskId),
    ) ?? null;
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
  ],
  design: [
    'task.updateBody',
    'task.setProperties',
    'task.setStatus',
    'seed.stage',
  ],
  ops: ['journal.setState', 'task.setStatus'],
};

function renderSkeleton(
  workflow: PlanningWorkflow,
  taskName: string,
  taskUrl: string,
): string {
  const label = SKILL_LABELS[workflow];
  const kinds = PLANNING_INTENT_KINDS[workflow];
  return [
    '## Session Lifecycle',
    '',
    `This is an injected, non-interactive ${label} session for a single target task ` +
      `(${taskName} — ${taskUrl}). There is no worktree and no feature branch — this ` +
      'session runs read-only/stage-only against the project checkout. When the ' +
      'procedure below reaches a natural stopping point (every open item presented ' +
      'and either staged or explicitly deferred), end the turn instead of waiting — ' +
      'the session parks into idle rather than scraping for a PR.',
    '',
    '## Transport',
    '',
    'Do not call the task backend, Notion, or any raw HTTP client directly. Every ' +
      'write is a staged intent submitted through the sanctioned session-side CLI ' +
      "client (POST /api/task-intents, authenticated by this session's scoped stage " +
      'credential). That endpoint only ever stages — applying a staged intent is a ' +
      'separate human/device-authenticated action this session cannot reach.',
    '',
    '## Structured Output Contract',
    '',
    `Stage findings as one of: ${kinds.join(', ')}. Every staged intent that ` +
      'proposes resolving an explicit open question, decision, or gate item must ' +
      'carry a `decisionProposal` annotation — a short human-readable string naming ' +
      'the question it resolves and the recommended answer — so the reviewing human ' +
      'sees the proposal instead of a bare payload diff. Batch multiple independent ' +
      'findings under a shared `groupId` when they were derived together; never ' +
      "silently apply — staging is the full extent of this session's authority.",
  ].join('\n');
}

// ─── per-kind procedure core ────────────────────────────────────────────────

function renderProcedureCore(workflow: PlanningWorkflow): string {
  const label = SKILL_LABELS[workflow];
  const lines: string[] = [`## ${label} Procedure`, ''];
  for (const step of stepsFor(workflow, { dispatched: true })) {
    lines.push(`### ${step.title}`, '', step.summary, '');
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

function renderGroomDigest(data: GroomDigestSlice): string {
  const lines: string[] = [
    '## Grooming Validation Slice',
    '',
    `- Task: ${data.task.title} (${data.task.type}, ${data.task.status}) — ${data.task.url}`,
    `- size_check seed: ${data.sizeCheckSeed.files} files affected (${data.sizeCheckSeed.loc_method})`,
    `- type_check: ${data.typeCheck.decision}${data.typeCheck.signals?.length ? ` — ${data.typeCheck.signals.join('; ')}` : ''}`,
    `- Binding constraints: ${data.bindingConstraints.length ? data.bindingConstraints.join(', ') : '(none)'}`,
  ];
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
}

/**
 * Compose the full injected planning-procedure prompt: skeleton + per-kind
 * procedure core + per-type digest, in that order. This is the string
 * written to the dispatched session's appended-prompt file.
 */
export function assemblePlanningProcedure(
  params: AssemblePlanningProcedureParams,
): string {
  const { taskName, taskUrl, digest } = params;
  const sections = [
    renderSkeleton(digest.workflow, taskName, taskUrl),
    renderProcedureCore(digest.workflow),
    renderDigest(digest),
  ];
  return sections.join('\n\n---\n\n');
}
