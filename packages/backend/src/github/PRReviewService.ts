import { logger } from '../logger';
import {
  getEventsBySession,
  setPRReviewResult,
  getPRByNumber,
  setReviewSessionId,
  clearReviewSessionId,
  updatePRDraftStatus,
  incrementReviewIteration,
  setLastReviewedSha,
  setLocalBranchReviewResult,
  getLocalBranchById,
  getSession,
  getPRIntentForPR,
  setPauseReason,
  getMergedPRForTask,
  getMergedLocalBranchForTaskId,
} from '../db/queries';
import type { OpsPrIntentPayload, PullRequestRow } from '../db/types';
import {
  getReservationForTaskDirSuffix,
  getReservationByNumber,
} from '../db/migrationReservation';
import { getCachedType } from '../tasks/TaskWriteCommands';
import { recordEvent } from '../audit/AuditLog';
import type { GitHubClient } from './GitHubClient';
import type { DiffSource } from './DiffSource';
import { GitHubDiffSource } from './DiffSource';
import { parseDiffFiles } from './GitHubClient';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { SessionManager } from '../session/SessionManager';
import { GitHubApiError, GitHubRateLimitError } from './types';
import { recordGitHubRateLimit } from './rateLimitBackoff';
import type {
  PullRequest,
  PRDiff,
  ReviewVerdictRecordedPayload,
} from './types';
import type { ServerMessage } from '../ws/types';
import type { SessionEvent } from '../db/types';
import type { PRMergeWatcher } from './PRMergeWatcher';
import type { AutoMerger } from './AutoMerger';
import type { DepthReviewService } from './DepthReviewService';

const RETRY_DELAYS = [250, 500, 1000] as const;
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Timeout for waitForVerdict — chosen below the 30-min stall-detector cutoff so the
// promise always resolves before the orchestrator force-clears the slot.
const VERDICT_TIMEOUT_MS = 25 * 60 * 1000;

export class FetchRetryExhaustedError extends Error {
  constructor(public readonly cause: Error) {
    super(
      `Diff fetch failed after ${RETRY_DELAYS.length} retries: ${cause.message}`,
    );
    this.name = 'FetchRetryExhaustedError';
  }
}

function isTransientFetchError(e: unknown): boolean {
  if (e instanceof TypeError && e.message.includes('fetch failed')) return true;
  if (e instanceof GitHubApiError && (e.status === 429 || e.status >= 500))
    return true;
  return false;
}

// Placeholder bodyRender.ts renders when a non-Code task has zero manual
// criteria — not a genuine checklist item, so it must never be stored/shown.
const MANUAL_VERIFICATION_SENTINEL =
  'Covered by the Manual Verification Gate task.';

function filterManualVerificationSentinel(
  items: string[] | undefined,
): string[] | undefined {
  if (!items) return items;
  return items.filter((item) => item !== MANUAL_VERIFICATION_SENTINEL);
}

/**
 * Code-enforced baseline escalation floor: high-blast-radius path categories that
 * always force escalate:true, independent of whether the project has any
 * review_rules configured. Conservative, broadly-applicable path conventions —
 * not project-tunable by design (see task: baseline escalation floor).
 */
const BASELINE_ESCALATION_FLOOR_PATTERNS: Array<{
  category: string;
  test: (path: string) => boolean;
}> = [
  {
    category: 'CI/workflow config',
    test: (path) => /(^|\/)\.github\/workflows\//.test(path),
  },
  {
    category: 'database migration',
    test: (path) => /(^|\/)(db\/)?migrations?\//i.test(path),
  },
  {
    category: 'auth',
    test: (path) => /(^|\/)auth[a-z0-9_-]*\.[a-z]+$/i.test(path),
  },
  {
    category: 'auth',
    test: (path) => /(^|\/)auth(\/|$)/i.test(path),
  },
  {
    category: 'secrets',
    test: (path) => /secret|credential/i.test(path),
  },
  {
    category: 'secrets',
    // basename check instead of a single regex to avoid a false-positive
    // ReDoS flag on the optional-suffix + anchor combination.
    test: (path) => {
      const basename = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
      return basename === '.env' || basename.startsWith('.env.');
    },
  },
];

export interface BaselineEscalationMatch {
  category: string;
  path: string;
}

/**
 * Exported so the depth-review routing branch (ReviewOrchestrator's
 * dispatchDepthReview) can reuse the same code-enforced floor patterns
 * rather than duplicating them — one category list, checked against two
 * separate review passes.
 */
export function matchBaselineEscalationFloor(
  filePaths: string[],
): BaselineEscalationMatch[] {
  const matches: BaselineEscalationMatch[] = [];
  for (const path of filePaths) {
    for (const { category, test } of BASELINE_ESCALATION_FLOOR_PATTERNS) {
      if (test(path)) {
        matches.push({ category, path });
        break; // one match per file is enough to explain the escalation
      }
    }
  }
  return matches;
}
export interface ReviewDimension {
  name: string;
  passed: boolean;
  notes: string;
}

/** Name of the dimension the migration-renumber pre-check overrides. Must match the JSON schema block below verbatim. */
const FILES_PATHS_DIMENSION_NAME = 'Changed files vs Files/paths affected list';

function isMigrationPath(path: string): boolean {
  return /(^|\/)(db\/)?migrations?\//i.test(path);
}

interface MigrationPathParts {
  dir: string;
  number: string;
  suffix: string;
}

function parseMigrationParts(path: string): MigrationPathParts | null {
  const slashIdx = path.lastIndexOf('/');
  const filename = slashIdx === -1 ? path : path.slice(slashIdx + 1);
  const m = filename.match(/^(\d+)_(.+)$/);
  if (!m) return null;
  return {
    dir: slashIdx === -1 ? '' : path.slice(0, slashIdx + 1),
    number: m[1],
    suffix: m[2],
  };
}

/**
 * Parses a Files/paths migration entry's path token into dir+suffix,
 * tolerating either a concrete leading number or an unsynced `NNN...`
 * placeholder (see groomLoad.ts's MIGRATION_PLACEHOLDER_RE) — the
 * reservation-override lookup only needs the placeholder's identity
 * (dir+suffix), not whichever number currently sits in the entry's raw text.
 */
function parseMigrationEntryDirSuffix(
  token: string,
): { dir: string; suffix: string } | null {
  const slashIdx = token.lastIndexOf('/');
  const filename = slashIdx === -1 ? token : token.slice(slashIdx + 1);
  const m = filename.match(/^(?:\d+|N{2,})_(.+)$/i);
  if (!m) return null;
  return {
    dir: slashIdx === -1 ? '' : token.slice(0, slashIdx + 1),
    suffix: m[1],
  };
}

interface MigrationRenumberMatch {
  diffPath: string;
  listedPath: string;
  number: string;
}

interface MigrationCollision {
  diffPath: string;
  collidesWithPath: string;
  number: string;
}

export interface MigrationRenumberEvaluation {
  /** Diff migration files that renumber a task-listed migration to a currently-free number — tolerated. */
  toleratedRenumbers: MigrationRenumberMatch[];
  /** Diff migration files whose new number is already used by a different migration on the base branch — not tolerated. */
  collisions: MigrationCollision[];
}

/**
 * Deterministic pre-check for the "Changed files vs Files/paths affected
 * list" dimension: a migration file in the diff that isn't literally listed
 * in the task is a legitimate renumber (not a spec violation) when it shares
 * a directory and name-suffix with a listed migration and differs only in
 * its leading number — UNLESS that number is already claimed by a different
 * migration on the base branch, in which case it's a real collision. Pure
 * function so identical inputs always produce identical output, independent
 * of LLM judgement — see the PRReviewService callers that fetch
 * `baseBranchMigrationPaths` and apply this as a code-level override.
 */
export function evaluateMigrationRenumberTolerance(
  diffMigrationPaths: string[],
  listedMigrationPaths: string[],
  baseBranchMigrationPaths: string[],
): MigrationRenumberEvaluation {
  const toleratedRenumbers: MigrationRenumberMatch[] = [];
  const collisions: MigrationCollision[] = [];
  const listedSet = new Set(listedMigrationPaths);

  for (const diffPath of diffMigrationPaths) {
    if (listedSet.has(diffPath)) continue; // literal match — nothing to evaluate
    const diffParts = parseMigrationParts(diffPath);
    if (!diffParts) continue;

    const listedMatch = listedMigrationPaths
      .map((p) => ({ p, parts: parseMigrationParts(p) }))
      .find(
        ({ parts }) =>
          parts &&
          parts.dir === diffParts.dir &&
          parts.suffix === diffParts.suffix &&
          parts.number !== diffParts.number,
      );
    if (!listedMatch) continue; // not a recognizable renumber — leave to LLM judgement

    const collidingBaseFile = baseBranchMigrationPaths.find((basePath) => {
      if (basePath === diffPath) return false;
      const baseParts = parseMigrationParts(basePath);
      return (
        baseParts !== null &&
        baseParts.dir === diffParts.dir &&
        baseParts.number === diffParts.number
      );
    });

    if (collidingBaseFile) {
      collisions.push({
        diffPath,
        collidesWithPath: collidingBaseFile,
        number: diffParts.number,
      });
    } else {
      toleratedRenumbers.push({
        diffPath,
        listedPath: listedMatch.p,
        number: diffParts.number,
      });
    }
  }

  return { toleratedRenumbers, collisions };
}

/**
 * Extracts migration file paths named in the task body's "Files / paths
 * affected" section (or, if that heading isn't found, the whole body — a
 * loose fallback so minor heading-format drift doesn't silently disable the
 * check). Scoped to migration-looking paths only; non-migration entries are
 * irrelevant to this pre-check and are left for the LLM's existing
 * tolerance for downstream files.
 */
export function extractListedMigrationPaths(taskBody: string): string[] {
  const sectionMatch = taskBody.match(
    /##+\s*Files\s*\/\s*paths[^\n]*\n([\s\S]*?)(?=\n##+\s|$)/i,
  );
  const section = sectionMatch ? sectionMatch[1] : taskBody;
  const matches = section.match(/[\w./-]*\bmigrations?\/[\w./-]+\.\w+/gi) ?? [];
  return [...new Set(matches)];
}

/**
 * Whether a task's own PR or local branch has already merged — the "already
 * merged" half of an out-of-band migration-reservation overtake (see
 * applyMigrationReservationOverride). A conflicting reservation whose owning
 * task hasn't merged yet is ordinary in-flight contention, not an overtake.
 */
function isTaskAlreadyMerged(taskId: string): boolean {
  return (
    getMergedPRForTask(taskId) !== null ||
    getMergedLocalBranchForTaskId(taskId) !== undefined
  );
}

/**
 * Applies an `evaluateMigrationRenumberTolerance` verdict to the parsed
 * review result's Files/paths dimension, overriding the LLM's own
 * passed/notes for that dimension and recomputing the top-level verdict
 * from the resulting pass count (per the schema's verdict rules). No-ops
 * when there's nothing to override, leaving the LLM's verdict untouched.
 */
export function overrideFilesPathsDimension(
  result: PRReviewResult,
  passed: boolean,
  note: string,
): PRReviewResult {
  if (!result.dimensions) return result;
  let found = false;
  const dimensions = result.dimensions.map((d) => {
    if (d.name !== FILES_PATHS_DIMENSION_NAME) return d;
    found = true;
    return {
      ...d,
      passed,
      notes: d.notes ? `${d.notes} ${note}` : note,
    };
  });
  if (!found) return result;
  const passedCount = dimensions.filter((d) => d.passed).length;
  const verdict: PRReviewResult['verdict'] =
    passedCount === dimensions.length
      ? 'approved'
      : passedCount === 0
        ? 'incomplete'
        : 'needs_changes';
  return { ...result, dimensions, verdict };
}

export interface PRReviewResult {
  prNumber: number;
  repo: string;
  verdict: 'approved' | 'needs_changes' | 'incomplete' | 'error';
  dimensions?: ReviewDimension[];
  summary: string;
  reviewedAt: string;
  /** Manual-verification items extracted from the task spec — for human review, not AI evaluation. */
  manualItemsForHuman?: string[];
  /** Full error detail when the session errored before producing output. */
  errorDetail?: string;
  /**
   * When true, the reviewer determined — per the project's review_rules — that
   * this finding requires operator attention rather than another coding-session
   * iteration. Routes to review_escalated instead of needs_changes feedback.
   */
  escalate?: boolean;
  /** Why the reviewer escalated. Present when escalate is true. */
  escalationReason?: string;
  /**
   * True when `escalate` was force-set by the code-level baseline escalation
   * floor (CI/config, migrations, auth, or secrets paths touched) rather than
   * by the project's review_rules or the LLM's own judgment. Distinguishes the
   * unconditional floor from the project-configured trigger downstream so the
   * two record different pause_reasons.
   */
  baselineEscalationFloor?: boolean;
  /**
   * True when `escalate` was force-set by applyMigrationReservationOverride
   * detecting an out-of-band overtake: the shipped migration number belongs,
   * per the reservation table, to a different task whose PR/branch has
   * already merged. Distinct from an ordinary same-task drift, which the
   * dimension override already fails on its own without escalation — see
   * ReviewOrchestrator.ts's pause-reason selection.
   */
  migrationReservationOvertaken?: boolean;
}

export type WorkItem =
  | { type: 'pr'; prNumber: number; repo: string }
  | {
      type: 'local_branch';
      localBranchId: number;
      branchName: string;
      baseBranch: string;
      sessionId: string;
      taskId?: string | null;
    };

/**
 * Guidance for the "Changed files vs Files/paths affected list" dimension
 * when reviewing against a Code task's task-body spec (the default rubric).
 */
const DEFAULT_FILES_DIMENSION_GUIDANCE = `For the "Changed files vs Files/paths affected list" dimension: Pass if all changed files are either listed in the task OR are necessary downstream updates caused by the listed changes (e.g., updating call sites after a type change, adjusting tests for modified behavior, fixing imports). Fail only if the PR touches files unrelated to the task's intent.`;

/**
 * The Ops rubric variant of DEFAULT_FILES_DIMENSION_GUIDANCE: an Ops
 * session's PR content is a mid-execution decision the task body never
 * declared up front (see OpsPrIntentPayload in db/types.ts), so this
 * dimension is evaluated against the operator-approved PR-intent's declared
 * scope (rendered in the "## Approved PR Intent" prompt section) instead of
 * a task-body Files/paths affected list.
 */
const OPS_PR_INTENT_FILES_DIMENSION_GUIDANCE = `For the "Changed files vs Files/paths affected list" dimension: this PR was opened by an Ops session against an operator-approved "## Approved PR Intent" declaration above, not a task-body Files/paths affected list — compare the changed files against that declaration's scope instead. Pass if all changed files are either within the declared scope OR are necessary downstream updates it implies (e.g., updating call sites after a type change, adjusting tests for modified behavior, fixing imports). Fail only if the PR touches files outside that approved scope.`;

/**
 * Shared review-instructions block: the JSON schema, verdict rules, and the
 * per-dimension guidance. Used by both the initial prompt and the re-review
 * follow-ups so the two stay in sync. `filesDimensionGuidance` is the only
 * part that varies between the default (Code task, task-body spec) and Ops
 * (approved PR-intent) rubrics — see buildPrompt's `prIntent` parameter.
 */
function buildReviewJsonSchemaBlock(
  filesDimensionGuidance: string = DEFAULT_FILES_DIMENSION_GUIDANCE,
): string {
  return `Respond ONLY with a JSON object — no preamble, no markdown fences.

## Manual verification items — DO NOT evaluate

💻 Code tasks do not carry a "### 👁️ Manual verification" section — runtime/manual
verification for a Code task is owned by the milestone's Manual Verification Gate, not
by this review. Do not look for one, and do not treat its absence as a gap.

A non-Code task spec (📐 Design, 🔧 Operational, 🔎 Investigation) may legitimately contain
a section titled "### 👁️ Manual verification" (or similar). Items under that heading
require a human reviewer — they CANNOT be verified by automated code review. When present,
you MUST:
- Exclude them entirely from your pass/fail evaluation of the "Diff vs Acceptance Criteria" dimension.
- Never fail the verdict solely because manual verification items are not demonstrated in the PR.
- List them verbatim in the "manualItemsForHuman" array so downstream tooling can surface them to a human.

Evaluate the PR across exactly these 4 dimensions and respond with this JSON schema:
{
  "verdict": "approved" | "needs_changes" | "incomplete",
  "dimensions": [
    { "name": "Title and description vs task Summary",        "passed": bool, "notes": "..." },
    { "name": "Diff vs Context spec",                         "passed": bool, "notes": "..." },
    { "name": "Diff vs Acceptance Criteria",                  "passed": bool, "notes": "..." },
    { "name": "Changed files vs Files/paths affected list",   "passed": bool, "notes": "..." }
  ],
  "summary": "2–4 sentence overall assessment",
  "manualItemsForHuman": ["verbatim item text", ...],
  "escalate": bool (optional, default false),
  "escalationReason": "..." (required when escalate is true)
}
verdict rules: "approved" = all 4 passed. "needs_changes" = 1–3 passed. "incomplete" = 0 passed.

Set "escalate": true only when your CLAUDE.md's "Project Review Criteria" section (if present) indicates this PR requires human/operator attention rather than another coding-session iteration — e.g. a policy violation only a human can adjudicate. Do not escalate for ordinary needs_changes findings a coding session can fix itself.

${filesDimensionGuidance}

Note: size-proportionality is judged separately, by a distinct depth-review pass that runs only after this conformance verdict is approved — do not evaluate it here.`;
}

const REVIEW_JSON_SCHEMA_BLOCK = buildReviewJsonSchemaBlock();

export class PRReviewService {
  constructor(
    private github: GitHubClient,
    /**
     * Optional fixed task backend. When provided (typically by tests), all task
     * fetches/status updates go through it. In production this is undefined and
     * the backend is resolved per-call via getTaskBackend(projectId).
     */
    private taskBackendOverride: TaskBackend | undefined,
    private sessionManager: SessionManager,
    private readonly defaultProjectId: string = '',
    private readonly defaultProjectContextUrl: string = '',
    /** Override the verdict wait timeout (ms). For tests only — production uses VERDICT_TIMEOUT_MS. */
    private readonly verdictTimeoutMs: number = VERDICT_TIMEOUT_MS,
  ) {}

  // Optional reference to PRMergeWatcher used to trigger an immediate mergeability
  // check after an approved verdict (so we don't wait for the next 5-min poll).
  // Set via setMergeWatcher() after both services are constructed (server.ts).
  private mergeWatcher?: PRMergeWatcher;

  setMergeWatcher(watcher: PRMergeWatcher): void {
    this.mergeWatcher = watcher;
  }

  // Optional reference to AutoMerger used to kick off the auto-merge polling
  // loop after an approved verdict on projects with autoMergeEnabled.
  private autoMerger?: AutoMerger;

  setAutoMerger(merger: AutoMerger): void {
    this.autoMerger = merger;
  }

  // Optional reference to DepthReviewService — presence (not the service
  // itself) gates the depth_review_pending hold below: only projects with a
  // depth pass actually dispatched should acquire a hold something will
  // clear. Set via setDepthReviewService() after both services are
  // constructed (server.ts), mirroring mergeWatcher/autoMerger.
  private depthReviewService?: DepthReviewService;

  setDepthReviewService(service: DepthReviewService): void {
    this.depthReviewService = service;
  }

  private resolveBackend(projectId: string): TaskBackend {
    return this.taskBackendOverride ?? getTaskBackend(projectId);
  }

  /**
   * Idempotent verdict persistence, keyed per head SHA. A stored verdict is
   * "complete" (approved/needs_changes) for a given head; a fresh verdict for
   * that SAME head that comes back incomplete (e.g. a waitForVerdict timeout
   * firing against a session that already delivered its verdict via the
   * review.verdict tool) must not overwrite it — the complete verdict is kept
   * and the attempted overwrite is only recorded to the audit log. A verdict
   * for a DIFFERENT head always persists normally, complete or not — the
   * idempotency guard is per head, not global.
   */
  private persistVerdict(
    prNumber: number,
    repo: string,
    headSha: string | null,
    finalResult: PRReviewResult,
    taskId?: string | null,
  ): { result: PRReviewResult; suppressed: boolean } {
    const current = getPRByNumber(prNumber, repo);
    if (
      finalResult.verdict === 'incomplete' &&
      headSha != null &&
      current?.last_reviewed_sha === headSha &&
      current.review_result
    ) {
      let stored: Partial<PRReviewResult> | null = null;
      try {
        stored = JSON.parse(current.review_result) as Partial<PRReviewResult>;
      } catch {
        stored = null;
      }
      const priorVerdict = stored?.verdict;
      if (priorVerdict === 'approved' || priorVerdict === 'needs_changes') {
        recordEvent({
          event_type: 'review_verdict_overwrite_suppressed',
          actor_type: 'system',
          actor_id: null,
          task_id: current.task_id ?? taskId ?? null,
          payload: {
            pr_number: prNumber,
            repo,
            head_sha: headSha,
            suppressed_verdict: finalResult.verdict,
            kept_verdict: priorVerdict,
          },
        });
        return {
          result: {
            prNumber,
            repo,
            verdict: priorVerdict as PRReviewResult['verdict'],
            dimensions: (stored?.dimensions as ReviewDimension[]) ?? [],
            summary: stored?.summary ?? '',
            reviewedAt: current.review_at ?? new Date().toISOString(),
            ...(stored?.manualItemsForHuman &&
            stored.manualItemsForHuman.length > 0
              ? { manualItemsForHuman: stored.manualItemsForHuman }
              : {}),
          },
          suppressed: true,
        };
      }
    }
    setPRReviewResult(prNumber, repo, JSON.stringify(finalResult));
    setLastReviewedSha(prNumber, repo, headSha);
    return { result: finalResult, suppressed: false };
  }

  /** Parses a PR row's stored review_result into a PRReviewResult, or null if absent/unparseable. */
  private storedResultOrNull(
    prNumber: number,
    repo: string,
    prRow: PullRequestRow,
  ): PRReviewResult | null {
    if (!prRow.review_result) return null;
    try {
      const stored = JSON.parse(prRow.review_result) as Partial<PRReviewResult>;
      if (!stored.verdict) return null;
      return {
        prNumber,
        repo,
        verdict: stored.verdict,
        dimensions: (stored.dimensions as ReviewDimension[]) ?? [],
        summary: stored.summary ?? '',
        reviewedAt: prRow.review_at ?? new Date().toISOString(),
        ...(stored.manualItemsForHuman && stored.manualItemsForHuman.length > 0
          ? { manualItemsForHuman: stored.manualItemsForHuman }
          : {}),
      };
    } catch {
      return null;
    }
  }

  async reviewPR(
    workItem: WorkItem,
    diffSource: DiffSource,
    projectId: string = this.defaultProjectId,
    projectContextUrl: string = this.defaultProjectContextUrl,
    sleep: (ms: number) => Promise<void> = defaultSleep,
  ): Promise<PRReviewResult> {
    if (workItem.type === 'local_branch') {
      return this.reviewLocalBranch(
        workItem,
        diffSource,
        projectId,
        projectContextUrl,
      );
    }

    const { prNumber, repo } = workItem;
    const prRow = getPRByNumber(prNumber, repo);
    if (!prRow) {
      throw new Error(`PR #${prNumber} in ${repo} not found in database`);
    }

    try {
      const existingReviewSessionId = prRow.review_session_id;

      // Case 1: Live review session exists — send follow-up with diff, do not spawn a new session.
      // review_session_id is intentionally NOT updated in this path.
      if (
        existingReviewSessionId &&
        this.sessionManager.isAlive(existingReviewSessionId)
      ) {
        // Register listener BEFORE sending to avoid missing a fast verdict.
        const abortController = new AbortController();
        const verdictPromise = this.waitForVerdict(
          existingReviewSessionId,
          prNumber,
          repo,
          this.verdictTimeoutMs,
          abortController.signal,
        );
        const prData = await this.withFetchRetry(
          () => this.github.fetchPR(repo, prNumber),
          sleep,
        );
        const diff = await this.withFetchRetry(
          () => diffSource.fetchDiff(),
          sleep,
        );
        const followUp = [
          `The code session has pushed new commits to PR #${prNumber}.`,
          `Please re-review the updated diff against the same task spec.`,
          ``,
          `### Updated PR Metadata`,
          `Title: ${prData.title}`,
          `Description: ${prData.body ?? '(none)'}`,
          ``,
          `### Updated Diff`,
          '```',
          diff,
          '```',
          REVIEW_JSON_SCHEMA_BLOCK,
        ].join('\n');
        const delivered = this.sessionManager.send(
          existingReviewSessionId,
          followUp,
        );
        if (!delivered) {
          logger.warn(
            `[PRReviewService] follow-up not confirmed delivered to review session ${existingReviewSessionId} for PR #${prNumber} — abandoning wait and falling back`,
          );
          recordEvent({
            event_type: 'session_nudge_delivery_failed',
            actor_type: 'system',
            actor_id: existingReviewSessionId,
            payload: {
              session_id: existingReviewSessionId,
              pr_number: prNumber,
              repo,
              reason: 'pr_review_followup',
            },
          });
          // The target session cannot be relied on to ever produce a
          // verdict — do not burn the full VERDICT_TIMEOUT_MS waiting on it.
          abortController.abort();
          clearReviewSessionId(prNumber, repo);
          if (prData.headSha && prData.headSha === prRow.last_reviewed_sha) {
            const stored = this.storedResultOrNull(prNumber, repo, prRow);
            if (
              stored &&
              (stored.verdict === 'approved' ||
                stored.verdict === 'needs_changes')
            ) {
              return stored;
            }
          }
          return this.reviewPR(
            workItem,
            diffSource,
            projectId,
            projectContextUrl,
            sleep,
          );
        }
        const aiResult = await verdictPromise;
        const taskBodyForMigrationCheck = await this.fetchTaskBodyBestEffort(
          projectId,
          prRow.task_id,
        );
        const finalResult = await this.applyMigrationReservationOverride(
          await this.applyMigrationRenumberOverride(
            this.applyBaselineEscalationFloor(aiResult, diff),
            diff,
            taskBodyForMigrationCheck,
            repo,
            prData.baseBranch,
          ),
          diff,
          taskBodyForMigrationCheck,
          prRow.task_id,
        );
        // Persist immediately after parse — before any side effects (GitHub/Notion).
        const { result: persistedResult1, suppressed: suppressed1 } =
          this.persistVerdict(
            prNumber,
            repo,
            prData.headSha ?? null,
            finalResult,
            prRow.task_id,
          );
        if (!suppressed1 && persistedResult1.verdict === 'approved') {
          await this.handleApprovedVerdict(
            prNumber,
            repo,
            prRow.task_id,
            projectId,
            persistedResult1.manualItemsForHuman,
          );
        }
        return persistedResult1;
      }

      const prData = await this.withFetchRetry(
        () => this.github.fetchPR(repo, prNumber),
        sleep,
      );
      const diff = await this.withFetchRetry(
        () => diffSource.fetchDiff(),
        sleep,
      );
      const diffData = { prId: prNumber, diff, filesChanged: [] };

      if (!prRow.task_id) {
        throw new Error(`PR #${prNumber} has no linked task`);
      }

      const taskBody = await this.resolveBackend(projectId).fetchTaskPage(
        prRow.task_id,
      );
      const prIntentRow = getPRIntentForPR(prNumber, repo);
      const prIntent = prIntentRow
        ? (JSON.parse(prIntentRow.payload) as OpsPrIntentPayload)
        : null;
      const prompt = this.buildPrompt(prData, diffData, taskBody, prIntent);

      // Guard: determine whether the stored session is still resumable before
      // entering Case 2. A session is resumable if its DB row exists and is not
      // in a terminal state. Rows missing entirely (pruned) or terminal
      // (done/error/killed) must not be passed to sendOrResume — that call
      // returns the dead ID unchanged, re-stores it, and wedges waitForVerdict.
      const existingSession = existingReviewSessionId
        ? (getSession(existingReviewSessionId) ?? null)
        : null;
      const isResumable =
        existingSession !== null &&
        !['done', 'error', 'killed'].includes(existingSession.status);

      if (existingReviewSessionId && !isResumable) {
        logger.warn(
          `[PRReviewService] Stale review_session_id ${existingReviewSessionId} for PR #${prNumber} ` +
            `(${existingSession ? `status=${existingSession.status}` : 'no DB row'}) — clearing and spawning fresh.`,
        );
        clearReviewSessionId(prNumber, repo);
        // Fall through to Case 3.
      }

      // Case 2: Dead-but-resumable existing review session — resume via
      // sendOrResume. Only reached when the stored session row exists and is
      // not in a terminal state.
      if (existingReviewSessionId && isResumable) {
        const resumedSessionId = await this.sessionManager.sendOrResume(
          existingReviewSessionId,
          prompt,
        );
        if (resumedSessionId != null) {
          setReviewSessionId(prNumber, repo, resumedSessionId);
          const aiResult = await this.waitForVerdict(
            resumedSessionId,
            prNumber,
            repo,
          );
          const finalResult = await this.applyMigrationReservationOverride(
            await this.applyMigrationRenumberOverride(
              this.applyBaselineEscalationFloor(aiResult, diff),
              diff,
              taskBody,
              repo,
              prData.baseBranch,
            ),
            diff,
            taskBody,
            prRow.task_id,
          );
          // Persist immediately after parse — before any side effects (GitHub/Notion).
          const { result: persistedResult2, suppressed: suppressed2 } =
            this.persistVerdict(
              prNumber,
              repo,
              prData.headSha ?? null,
              finalResult,
              prRow.task_id,
            );
          if (!suppressed2 && persistedResult2.verdict === 'approved') {
            await this.handleApprovedVerdict(
              prNumber,
              repo,
              prRow.task_id,
              projectId,
              persistedResult2.manualItemsForHuman,
            );
          }
          return persistedResult2;
        }
        // Defensive: sendOrResume rejected despite appearing resumable — treat as stale.
        logger.warn(
          `[PRReviewService] sendOrResume returned null for ${existingReviewSessionId} — spawning fresh.`,
        );
        clearReviewSessionId(prNumber, repo);
      }

      // Case 3: No prior review session — spawn a fresh session.
      // Generate the session ID before starting so the verdict listener can be
      // subscribed before any events are emitted. Without this, fast reviews
      // (verdict emitted within seconds, before waitForVerdict subscribes) are
      // silently missed and fall through to the timeout.
      const sessionId = crypto.randomUUID();

      // 1. Attach listener BEFORE start() — ensures no events are missed.
      const verdictPromise = this.waitForVerdict(sessionId, prNumber, repo);

      // 2. Start session with the pre-generated ID. For review sessions, taskUrl
      // is used only for display/storage; the actual task association is carried
      // by taskId so it works for any backend (github, notion, etc.).
      await this.sessionManager.start(projectContextUrl, projectContextUrl, {
        sessionId,
        sessionType: 'review',
        customPrompt: prompt,
        projectId,
        taskName: `#${prData.id} ${prData.title}`,
        taskId: prRow.task_id ?? undefined,
      });

      // 3. Persist the review session pairing and record the SHA under review.
      // Setting last_reviewed_sha here (before await verdictPromise) closes a race
      // window: AgentSession fires push_detected on every result event once
      // review_session_id is set, and shouldAutoReview returns true when
      // last_reviewed_sha is null. By recording it now, any push_detected during
      // the review sees headSha === last_reviewed_sha and is correctly skipped.
      setReviewSessionId(prNumber, repo, sessionId);
      setLastReviewedSha(prNumber, repo, prData.headSha ?? null);
      recordEvent({
        event_type: 'pr_opened',
        actor_type: 'system',
        actor_id: null,
        project_id: projectId || null,
        task_id: prRow.task_id ?? null,
        payload: {
          pr_number: prNumber,
          repo,
          head_sha: prData.headSha ?? null,
        },
      });

      const aiResult = await verdictPromise;
      const finalResult = await this.applyMigrationReservationOverride(
        await this.applyMigrationRenumberOverride(
          this.applyBaselineEscalationFloor(aiResult, diff),
          diff,
          taskBody,
          repo,
          prData.baseBranch,
        ),
        diff,
        taskBody,
        prRow.task_id,
      );
      // Persist immediately after parse — before any side effects (GitHub/Notion).
      // setLastReviewedSha was already called above the verdictPromise await for
      // the race-window guard; the verdict write here is the critical safety net.
      const { result: persistedResult3, suppressed: suppressed3 } =
        this.persistVerdict(
          prNumber,
          repo,
          prData.headSha ?? null,
          finalResult,
          prRow.task_id,
        );
      if (!suppressed3 && persistedResult3.verdict === 'approved') {
        await this.handleApprovedVerdict(
          prNumber,
          repo,
          prRow.task_id,
          projectId,
          persistedResult3.manualItemsForHuman,
        );
      }
      return persistedResult3;
    } catch (e: unknown) {
      if (e instanceof FetchRetryExhaustedError) {
        this.sessionManager.emit('message', {
          type: 'review_failed',
          prNumber,
          repo,
          message: e.message,
        });
      }
      throw e;
    }
  }

  private async reviewLocalBranch(
    workItem: Extract<WorkItem, { type: 'local_branch' }>,
    diffSource: DiffSource,
    projectId: string,
    projectContextUrl: string,
  ): Promise<PRReviewResult> {
    const { localBranchId, branchName, baseBranch, taskId } = workItem;
    const localBranchRow = getLocalBranchById(localBranchId);
    if (!localBranchRow) {
      throw new Error(`Local branch row #${localBranchId} not found`);
    }

    const diff = await diffSource.fetchDiff();

    let taskBody = '';
    if (taskId) {
      try {
        taskBody = await this.resolveBackend(projectId).fetchTaskPage(taskId);
      } catch (e) {
        logger.warn(
          `[PRReviewService] fetchTaskPage failed for local branch review (task ${taskId}):`,
          e,
        );
      }
    }

    const prompt = this.buildLocalBranchPrompt(
      branchName,
      baseBranch,
      diff,
      taskBody,
    );

    // Use a synthetic prNumber/repo for the verdict listener (not a real PR)
    const syntheticPrNumber = localBranchId;
    const syntheticRepo = `local/${branchName}`;

    const sessionId = crypto.randomUUID();
    const verdictPromise = this.waitForVerdict(
      sessionId,
      syntheticPrNumber,
      syntheticRepo,
    );

    await this.sessionManager.start(projectContextUrl, projectContextUrl, {
      sessionId,
      sessionType: 'review',
      customPrompt: prompt,
      projectId,
      taskName: branchName,
      taskId: taskId ?? undefined,
    });

    const aiResult = await verdictPromise;
    const result = this.applyBaselineEscalationFloor(aiResult, diff);

    setLocalBranchReviewResult(localBranchId, JSON.stringify(result));
    return result;
  }

  private buildLocalBranchPrompt(
    branchName: string,
    baseBranch: string,
    diff: string,
    taskBody: string,
  ): string {
    return `You are a code reviewer. Compare the following local branch diff against its task specification.

## Branch Metadata
Branch: ${branchName}
Base: ${baseBranch}

## Diff
${diff}

## Task Specification
${taskBody || '(no task specification available)'}

## Your task
${REVIEW_JSON_SCHEMA_BLOCK}`;
  }

  /**
   * Handle post-verdict side effects when a PR is approved: transition draft → ready
   * on GitHub, and update the Notion task status to 👀 In Review.
   * Returns true if the PR was successfully transitioned from draft to ready.
   */
  async handleApprovedVerdict(
    prNumber: number,
    repo: string,
    taskId: string | null,
    projectId?: string,
    manualItemsForHuman?: string[],
  ): Promise<boolean> {
    let draftTransitioned = false;
    const resolvedProjectId = projectId || this.defaultProjectId;
    try {
      await this.github.markPRReady(repo, prNumber);
      updatePRDraftStatus(prNumber, repo, 0);
      draftTransitioned = true;
    } catch (e) {
      if (e instanceof GitHubRateLimitError) {
        recordGitHubRateLimit(e, '[PRReviewService]');
      } else {
        logger.warn(
          `[PRReviewService] markPRReady skipped for PR #${prNumber}:`,
          e,
        );
      }
      // Left as draft — PRMergeWatcher's draft-ready sweep re-attempts
      // markPRReady for any PR whose review_result is approved but is still
      // draft, so a rate-limit 403 here is recoverable rather than terminal.
      recordEvent({
        event_type: 'review_side_effect_failed',
        actor_type: 'system',
        actor_id: null,
        project_id: resolvedProjectId || null,
        task_id: taskId,
        payload: {
          pr_number: prNumber,
          repo,
          side_effect: 'markPRReady',
          error: String(e),
        },
      });
    }
    if (taskId && resolvedProjectId) {
      try {
        await this.resolveBackend(resolvedProjectId).updateStatus(
          taskId,
          '👀 In Review',
        );
      } catch (e: unknown) {
        logger.error(`[PRReviewService] task backend updateStatus failed:`, e);
        recordEvent({
          event_type: 'review_side_effect_failed',
          actor_type: 'system',
          actor_id: null,
          project_id: resolvedProjectId || null,
          task_id: taskId,
          payload: {
            pr_number: prNumber,
            repo,
            side_effect: 'updateStatus',
            error: String(e),
          },
        });
      }
    }
    // Trigger an immediate mergeability check so the watcher's DB merge_state and
    // WS event reflect current state — don't wait for the next 5-min poll.
    if (this.mergeWatcher) {
      this.mergeWatcher
        .checkMergeabilityNow(prNumber, repo)
        .catch((err: unknown) =>
          logger.warn(
            `[PRReviewService] checkMergeabilityNow failed for PR #${prNumber}:`,
            (err as Error).message,
          ),
        );
    }
    // Hold auto-merge when the task's cached Type is not 💻 Code — those
    // tasks may carry manual-verification items that only a human can sign
    // off on. A cache miss (getCachedType returns null) is treated as
    // eligible for the hold — fail closed, matching getCachedType's own
    // doc-comment precedent for checkGroomingPromotionGate. This re-derives
    // on every approved verdict (initial review and re-review alike), so a
    // fresh diff always re-arms the hold even if an operator cleared a prior
    // round.
    const cachedType = taskId ? getCachedType(taskId) : null;
    if (cachedType !== '💻 Code') {
      setPauseReason(
        prNumber,
        repo,
        'manual_verification_pending',
        manualItemsForHuman && manualItemsForHuman.length > 0
          ? JSON.stringify(manualItemsForHuman)
          : undefined,
      );
    } else if (this.depthReviewService) {
      // Hold auto-merge while the depth review pass is in flight, so a depth
      // finding can gate the merge instead of only annotating an
      // already-merged PR. Gated on depthReviewService being configured — a
      // project without depth review would otherwise acquire a hold nothing
      // clears. `else if` so this never clobbers manual_verification_pending
      // above — that hold takes precedence and dispatchDepthReview's
      // unconditional clear must not race it closed early.
      // dispatchDepthReview (ReviewOrchestrator) clears this on every exit
      // path (escalation, feedback-enqueue, fail-open, or timeout).
      setPauseReason(prNumber, repo, 'depth_review_pending');
    }
    // Kick off the auto-merger (per-project opt-in; AutoMerger guards on the
    // project toggle and on pause_reason). Fire-and-forget — the polling loop
    // runs in the background.
    if (this.autoMerger) {
      this.autoMerger.attempt(prNumber, repo);
    }
    return draftTransitioned;
  }

  /**
   * Send a re-review follow-up to the existing review session for the given PR.
   * Uses sendOrResume() so it works even if the review session has exited.
   * Falls back to a fresh reviewPR() if no review_session_id is set on the PR row.
   * Increments review_iteration in the DB.
   */
  async reReviewPR(
    prNumber: number,
    repo: string,
    projectId: string = this.defaultProjectId,
    projectContextUrl: string = this.defaultProjectContextUrl,
  ): Promise<PRReviewResult> {
    const pr = getPRByNumber(prNumber, repo);
    if (pr && (pr.state === 'merged' || pr.state === 'closed')) {
      logger.info(
        `[PRReviewService] reReviewPR PR #${prNumber}: state=${pr.state} — skipping re-review`,
      );
      recordEvent({
        event_type: 're_review_skipped_pr_terminal',
        actor_type: 'system',
        actor_id: null,
        task_id: pr.task_id ?? null,
        payload: { pr_number: prNumber, repo, state: pr.state },
      });
      const stored = this.storedResultOrNull(prNumber, repo, pr);
      return (
        stored ?? {
          prNumber,
          repo,
          verdict: 'incomplete',
          dimensions: [],
          summary: `PR is ${pr.state} — re-review skipped.`,
          reviewedAt: new Date().toISOString(),
        }
      );
    }
    if (!pr?.review_session_id) {
      // No paired review session — fall back to fresh review
      const diffSource = new GitHubDiffSource(this.github, repo, prNumber);
      return this.reviewPR(
        { type: 'pr', prNumber, repo },
        diffSource,
        projectId,
        projectContextUrl,
      );
    }

    const prData = await this.github.fetchPR(repo, prNumber);

    // Dedup guard: skip if the head SHA hasn't changed since the last review.
    // Dedup key: (prNumber, repo, headSha). This is a secondary defence — the
    // primary protection is that reviewPR() Case 3 now sets last_reviewed_sha
    // before awaiting the verdict, so shouldAutoReview() in server.ts already
    // blocks same-SHA re-reviews via push_detected.
    if (prData.headSha && prData.headSha === pr.last_reviewed_sha) {
      logger.info(
        `[PRReviewService] reReviewPR PR #${prNumber}: headSha ${prData.headSha} matches last_reviewed_sha — skipping duplicate re-review`,
      );
      const stored = (() => {
        try {
          return pr.review_result
            ? (JSON.parse(pr.review_result) as Partial<PRReviewResult>)
            : null;
        } catch {
          return null;
        }
      })();
      return {
        prNumber,
        repo,
        verdict: (stored?.verdict as PRReviewResult['verdict']) ?? 'incomplete',
        dimensions: (stored?.dimensions as ReviewDimension[]) ?? [],
        summary: stored?.summary ?? '(no new commits — re-review skipped)',
        reviewedAt: new Date().toISOString(),
      };
    }

    // The target review session's status must be checked before attempting
    // to reach it: sendOrResume() will happily reopen a terminal (done/
    // error/killed) session via --resume, which is exactly the "resurrect a
    // finished session to deliver a bogus verdict" failure mode this guards
    // against. A terminal session with a changed head gets a fresh review
    // session instead of a follow-up.
    const existingSession = getSession(pr.review_session_id);
    const isSessionTerminal =
      !existingSession ||
      ['done', 'error', 'killed'].includes(existingSession.status);
    if (isSessionTerminal) {
      logger.warn(
        `[PRReviewService] reReviewPR PR #${prNumber}: review session ${pr.review_session_id} is terminal ` +
          `(${existingSession ? `status=${existingSession.status}` : 'no DB row'}) — launching fresh review session instead of a follow-up.`,
      );
      clearReviewSessionId(prNumber, repo);
      const diffSource = new GitHubDiffSource(this.github, repo, prNumber);
      return this.reviewPR(
        { type: 'pr', prNumber, repo },
        diffSource,
        projectId,
        projectContextUrl,
      );
    }

    const branches =
      prData.baseBranch && prData.headBranch
        ? { base: prData.baseBranch, head: prData.headBranch }
        : undefined;
    // Re-review uses the FULL PR diff (compare endpoint), not just the
    // incremental delta, so the diff always reflects total churn across the
    // lifetime of the PR.
    const diffData = await this.github.fetchDiff(prNumber, repo, branches);

    // Surface the prior incomplete reason so the reviewer knows what to focus on.
    const priorResult = (() => {
      try {
        return pr.review_result
          ? (JSON.parse(pr.review_result) as Partial<PRReviewResult>)
          : null;
      } catch {
        return null;
      }
    })();
    const priorIncompleteLines: string[] = [];
    if (priorResult?.verdict === 'incomplete') {
      priorIncompleteLines.push('');
      priorIncompleteLines.push('### Prior Review Context');
      priorIncompleteLines.push(
        `The previous review returned an **incomplete** verdict: "${priorResult.summary ?? ''}"`,
      );
      for (const d of (priorResult.dimensions ?? []).filter(
        (d) => !(d as ReviewDimension).passed,
      )) {
        priorIncompleteLines.push(
          `- **${(d as ReviewDimension).name}**: ${(d as ReviewDimension).notes}`,
        );
      }
      priorIncompleteLines.push(
        'When reviewing the new commits, focus on whether these dimensions are now assessable.',
      );
    }

    const followUp = [
      `The code session has pushed new commits to PR #${prNumber}.`,
      `Please re-review the updated diff against the same task spec.`,
      ...priorIncompleteLines,
      ``,
      `### Updated PR Metadata`,
      `Title: ${prData.title}`,
      `Description: ${prData.body ?? '(none)'}`,
      ``,
      `### Updated Diff`,
      '```',
      diffData.diff,
      '```',
      REVIEW_JSON_SCHEMA_BLOCK,
    ].join('\n');

    // Increment iteration before sending so the DB reflects the new iteration
    incrementReviewIteration(prNumber, repo);

    // Send to the existing review session (resumes via --resume if it has exited)
    const resumedSessionId = await this.sessionManager.sendOrResume(
      pr.review_session_id,
      followUp,
    );
    if (resumedSessionId == null) {
      throw new Error(
        `reReviewPR: review session ${pr.review_session_id} is terminal or missing — cannot re-review PR #${prNumber}`,
      );
    }
    if (resumedSessionId !== pr.review_session_id) {
      setReviewSessionId(prNumber, repo, resumedSessionId);
    }

    const aiResult = await this.waitForVerdict(
      resumedSessionId,
      prNumber,
      repo,
    );
    const taskBodyForMigrationCheck = await this.fetchTaskBodyBestEffort(
      projectId,
      pr.task_id,
    );
    const finalResult = await this.applyMigrationReservationOverride(
      await this.applyMigrationRenumberOverride(
        this.applyBaselineEscalationFloor(aiResult, diffData.diff),
        diffData.diff,
        taskBodyForMigrationCheck,
        repo,
        prData.baseBranch,
      ),
      diffData.diff,
      taskBodyForMigrationCheck,
      pr.task_id,
    );
    const { result: persistedResult4, suppressed: suppressed4 } =
      this.persistVerdict(
        prNumber,
        repo,
        prData.headSha ?? null,
        finalResult,
        pr.task_id,
      );
    if (!suppressed4 && persistedResult4.verdict === 'approved') {
      await this.handleApprovedVerdict(
        prNumber,
        repo,
        pr.task_id,
        projectId,
        persistedResult4.manualItemsForHuman,
      );
    }
    return persistedResult4;
  }

  /**
   * Listen for a schema-validated review.verdict MCP tool call
   * (review_verdict_recorded, see AgentSession.recordReviewVerdict) and
   * resolve with it directly, in preference to the legacy text-parsing
   * path. Also still listens to session_event messages for `sessionId` and
   * resolves with the first verdict JSON block found in an assistant
   * message, so a session that never calls the tool still resolves.
   * Falls back to parseReviewResult over stored events if session_ended fires first.
   */
  /**
   * signal: when provided and aborted, tears down listeners/timer immediately
   * without resolving — used by callers that discover mid-wait (e.g. a failed
   * follow-up send) that the target session can never produce a verdict, so
   * the caller can fall back on its own terms instead of burning the full
   * VERDICT_TIMEOUT_MS.
   */
  private waitForVerdict(
    sessionId: string,
    prNumber: number,
    repo: string,
    timeoutMs: number = this.verdictTimeoutMs,
    signal?: AbortSignal,
  ): Promise<PRReviewResult> {
    return new Promise<PRReviewResult>((resolve) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        this.sessionManager.off('message', handler);
        this.sessionManager.off('review_verdict_recorded', verdictHandler);
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        cleanup();
        // No resolve() — the promise is intentionally left pending; the
        // aborting caller does not await it.
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort);
      }

      const verdictHandler = (payload: ReviewVerdictRecordedPayload) => {
        if (payload.sessionId !== sessionId) return;
        cleanup();
        resolve({
          prNumber,
          repo,
          verdict: payload.verdict.verdict,
          dimensions: payload.verdict.dimensions as ReviewDimension[],
          summary: payload.verdict.summary,
          reviewedAt: new Date().toISOString(),
          ...(payload.verdict.manualItemsForHuman &&
          payload.verdict.manualItemsForHuman.length > 0
            ? { manualItemsForHuman: payload.verdict.manualItemsForHuman }
            : {}),
          ...(payload.verdict.escalate
            ? {
                escalate: payload.verdict.escalate,
                escalationReason: payload.verdict.escalationReason,
              }
            : {}),
        });
      };

      const handler = (msg: ServerMessage) => {
        if (!('sessionId' in msg) || msg.sessionId !== sessionId) return;

        if (msg.type === 'session_event' && msg.eventType === 'text') {
          const result = this.tryParseVerdictFromRawEvent(
            msg.content,
            prNumber,
            repo,
          );
          if (result) {
            cleanup();
            resolve(result);
          }
          return;
        }

        if (msg.type === 'session_ended') {
          cleanup();
          // If the session ended in error before producing output, surface the real cause.
          const sessionRow = getSession(sessionId);
          if (sessionRow?.status === 'error' && sessionRow.last_error_detail) {
            resolve({
              prNumber,
              repo,
              verdict: 'incomplete',
              dimensions: [],
              summary: `Review session errored before producing output: ${sessionRow.pause_reason ?? 'launch_failed'}`,
              errorDetail: sessionRow.last_error_detail,
              reviewedAt: new Date().toISOString(),
            });
            return;
          }
          // Fallback: parse from stored events (tolerant/repair parse included)
          const events = getEventsBySession(sessionId);
          const result = this.parseReviewResult(
            events,
            prNumber,
            repo,
            sessionId,
          );
          resolve(result);
        }
      };

      this.sessionManager.on('message', handler);
      this.sessionManager.on('review_verdict_recorded', verdictHandler);

      timeoutHandle = setTimeout(() => {
        cleanup();
        logger.warn(
          `[PRReviewService] waitForVerdict timed out after ${Math.round(timeoutMs / 60000)} min for session ${sessionId} (PR #${prNumber} ${repo}) — attempting lenient parse of stored events`,
        );
        // Try to recover the verdict from whatever events were stored before the hang.
        // tryParseVerdict (called inside parseReviewResult) now includes a repair pass,
        // so malformed-JSON verdicts (e.g. unescaped inner quotes) resolve here.
        const events = getEventsBySession(sessionId);
        const recovered = this.parseReviewResult(
          events,
          prNumber,
          repo,
          sessionId,
        );
        if (recovered.verdict !== 'incomplete') {
          resolve(recovered);
          return;
        }
        // Could not recover a verdict — resolve as incomplete with a timeout summary.
        resolve({
          prNumber,
          repo,
          verdict: 'incomplete',
          dimensions: [],
          summary: `Review verdict timed out after ${Math.round(timeoutMs / 60000)} min — verdict JSON could not be parsed from stored events.`,
          reviewedAt: new Date().toISOString(),
        });
      }, timeoutMs);
    });
  }

  /**
   * Try to parse a PRReviewResult verdict from the raw JSON payload of a
   * session_event with eventType='text'. Returns null if no valid verdict found.
   */
  private tryParseVerdictFromRawEvent(
    rawEventPayload: string,
    prNumber: number,
    repo: string,
  ): PRReviewResult | null {
    try {
      const event = JSON.parse(rawEventPayload) as Record<string, unknown>;
      if (event.type !== 'assistant') return null;
      const msg = event.message as Record<string, unknown> | undefined;
      const content = msg?.content as
        | Array<Record<string, unknown>>
        | undefined;
      if (!content) return null;

      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const parsed = this.tryParseVerdict(block.text);
          if (parsed) {
            return {
              prNumber,
              repo,
              verdict: parsed.verdict,
              dimensions: parsed.dimensions,
              summary: parsed.summary,
              reviewedAt: new Date().toISOString(),
              ...(parsed.manualItemsForHuman
                ? { manualItemsForHuman: parsed.manualItemsForHuman }
                : {}),
              ...(parsed.escalate
                ? {
                    escalate: parsed.escalate,
                    escalationReason: parsed.escalationReason,
                  }
                : {}),
            };
          }
        }
      }
    } catch {
      // Not parseable — skip
    }
    return null;
  }

  /** Try to parse a JSON verdict object from a text string. Returns null on failure. */
  private tryParseVerdict(text: string): {
    verdict: PRReviewResult['verdict'];
    dimensions: ReviewDimension[];
    summary: string;
    manualItemsForHuman?: string[];
    escalate?: boolean;
    escalationReason?: string;
  } | null {
    const candidate = this.extractJsonCandidate(text.trim());
    if (!candidate) {
      return null;
    }
    const repaired = this.repairTrailingCommas(candidate);
    return (
      this.parseVerdictObject(candidate) ??
      this.parseVerdictObject(repaired) ??
      this.parseVerdictObject(this.repairJsonStrings(candidate)) ??
      this.parseVerdictObject(this.repairJsonStrings(repaired))
    );
  }

  /**
   * Attempt to parse a raw JSON string into a verdict object. Returns null if
   * the string is not valid JSON or does not contain a verdict token.
   * dimensions and summary are optional and default to [] / '' when absent
   * so that near-miss reviewer output (verdict present, schema incomplete)
   * is not incorrectly classified as incomplete.
   */
  private parseVerdictObject(json: string): {
    verdict: PRReviewResult['verdict'];
    dimensions: ReviewDimension[];
    summary: string;
    manualItemsForHuman?: string[];
    escalate?: boolean;
    escalationReason?: string;
  } | null {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      if (typeof parsed.verdict === 'string') {
        const dimensions = Array.isArray(parsed.dimensions)
          ? (parsed.dimensions as ReviewDimension[])
          : [];
        const summary =
          typeof parsed.summary === 'string' ? parsed.summary : '';
        const manualItems = Array.isArray(parsed.manualItemsForHuman)
          ? filterManualVerificationSentinel(
              (parsed.manualItemsForHuman as string[]).filter(
                (item) => typeof item === 'string',
              ),
            )
          : undefined;
        const escalate = parsed.escalate === true;
        const escalationReason =
          typeof parsed.escalationReason === 'string'
            ? parsed.escalationReason
            : undefined;
        return {
          verdict: parsed.verdict as PRReviewResult['verdict'],
          dimensions,
          summary,
          ...(manualItems && manualItems.length > 0
            ? { manualItemsForHuman: manualItems }
            : {}),
          ...(escalate ? { escalate, escalationReason } : {}),
        };
      }
    } catch {
      // Not valid JSON
    }
    return null;
  }

  /** Remove trailing commas before } or ] to repair common LLM JSON near-misses. */
  private repairTrailingCommas(json: string): string {
    return json.replace(/,(\s*[}\]])/g, '$1');
  }

  /**
   * Heuristic JSON repair: escape unescaped double-quotes inside string values.
   * Handles the LLM-common pattern of embedding human-readable text with inner
   * quotes, e.g. `"manualItemsForHuman": ["the "term" here is visible"]`.
   * A closing string-quote is one followed (after optional whitespace) by a JSON
   * structural character: , ] } : or end-of-input.
   */
  private repairJsonStrings(json: string): string {
    let result = '';
    let inString = false;
    let escape = false;

    for (let i = 0; i < json.length; i++) {
      const ch = json[i];

      if (escape) {
        result += ch;
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        result += ch;
        escape = true;
        continue;
      }

      if (ch === '"') {
        if (!inString) {
          inString = true;
          result += ch;
          continue;
        }
        // Peek ahead past whitespace to determine if this quote closes the string.
        let j = i + 1;
        while (
          j < json.length &&
          (json[j] === ' ' ||
            json[j] === '\t' ||
            json[j] === '\r' ||
            json[j] === '\n')
        ) {
          j++;
        }
        const next = j < json.length ? json[j] : '';
        if (
          next === ',' ||
          next === ']' ||
          next === '}' ||
          next === ':' ||
          next === '"' ||
          next === ''
        ) {
          // This quote closes the string value.
          inString = false;
          result += ch;
        } else {
          // Inner quote — escape it.
          result += '\\"';
        }
        continue;
      }

      result += ch;
    }

    return result;
  }

  /**
   * Strip markdown fences and extract the first top-level `{...}` JSON object
   * from `text`. Returns null if no object boundary is found.
   */
  private extractJsonCandidate(text: string): string | null {
    // Strip markdown code fences: ```json ... ``` or ``` ... ```
    const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (fenceMatch) {
      return fenceMatch[1].trim();
    }

    // Find first '{' and walk brace depth to extract complete object
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  /**
   * Code-level escalation floor: force escalate:true when the diff touches a
   * high-blast-radius path category (CI/workflow config, migrations, auth,
   * secrets), regardless of the project's review_rules or the LLM's own
   * "escalate" claim. Unconditional: does not affect verdict/dimensions, only
   * the escalate/escalationReason fields.
   */
  private applyBaselineEscalationFloor(
    result: PRReviewResult,
    diffText: string,
  ): PRReviewResult {
    const matches = matchBaselineEscalationFloor(parseDiffFiles(diffText));
    if (matches.length === 0) return result;

    const byCategory = [...new Set(matches.map((m) => m.category))];
    const paths = [...new Set(matches.map((m) => m.path))];
    const floorReason = `Baseline escalation floor: diff touches ${byCategory.join(', ')} path(s): ${paths.join(', ')}`;

    return {
      ...result,
      escalate: true,
      escalationReason: result.escalationReason
        ? `${result.escalationReason} | ${floorReason}`
        : floorReason,
      baselineEscalationFloor: true,
    };
  }

  /**
   * Deterministic override for the "Changed files vs Files/paths affected
   * list" dimension when the only deviation is a migration file renumbered
   * away from the task-listed number (see evaluateMigrationRenumberTolerance
   * for the rule). Fetches the base branch's file listing to check for a
   * number collision; on fetch failure it fails open by leaving the LLM's
   * verdict untouched rather than risking a false pass/fail from an
   * unverifiable collision check. No-ops entirely (no network call) when the
   * diff contains no migration file that isn't already listed verbatim.
   */
  private async applyMigrationRenumberOverride(
    result: PRReviewResult,
    diffText: string,
    taskBody: string,
    repo: string,
    baseBranch: string,
  ): Promise<PRReviewResult> {
    const diffMigrationPaths = parseDiffFiles(diffText).filter(isMigrationPath);
    if (diffMigrationPaths.length === 0) return result;

    const listedMigrationPaths = extractListedMigrationPaths(taskBody);
    const hasUnlistedMigration = diffMigrationPaths.some(
      (p) => !listedMigrationPaths.includes(p),
    );
    if (!hasUnlistedMigration) return result;

    let baseBranchMigrationPaths: string[];
    try {
      baseBranchMigrationPaths = (
        await this.github.listFilePathsAtRef(repo, baseBranch)
      ).filter(isMigrationPath);
    } catch (e) {
      logger.warn(
        `[PRReviewService] failed to fetch base-branch file listing for migration-renumber check on ${repo}@${baseBranch}: ${(e as Error).message}`,
      );
      return result;
    }

    const evaluation = evaluateMigrationRenumberTolerance(
      diffMigrationPaths,
      listedMigrationPaths,
      baseBranchMigrationPaths,
    );

    if (evaluation.collisions.length > 0) {
      const note = `Deterministic migration-renumber check: ${evaluation.collisions
        .map(
          (c) =>
            `${c.diffPath} reuses migration number ${c.number}, already claimed by ${c.collidesWithPath} on ${baseBranch}`,
        )
        .join('; ')}.`;
      return overrideFilesPathsDimension(result, false, note);
    }

    if (evaluation.toleratedRenumbers.length > 0) {
      const note = `Deterministic migration-renumber check: ${evaluation.toleratedRenumbers
        .map(
          (t) =>
            `${t.diffPath} is a legitimate renumber of task-listed ${t.listedPath} (number ${t.number} is free on ${baseBranch})`,
        )
        .join('; ')} — tolerated.`;
      return overrideFilesPathsDimension(result, true, note);
    }

    return result;
  }

  /**
   * Deterministic override for the "Changed files vs Files/paths affected
   * list" dimension: for each `*(new)*` migration entry in the task's
   * Files/paths list, the migration_reservation table — not the LLM's own
   * arithmetic — is the literal source of truth for which number that entry
   * claimed (see migrationReservation.ts's Ready-flip allocation + body-prose
   * sync). A shipped migration file whose number matches the reservation
   * forces the dimension to pass regardless of the LLM's raw verdict; a
   * mismatch forces it to fail, with the expected/actual numbers rendered
   * explicitly rather than left to the LLM's prose. Applied after
   * applyMigrationRenumberOverride so this literal check has the final say
   * for entries it recognizes. No-ops (no DB call) when the task has no
   * `*(new)*` migration entry or no linked task.
   */
  private async applyMigrationReservationOverride(
    result: PRReviewResult,
    diffText: string,
    taskBody: string,
    taskId: string | null | undefined,
  ): Promise<PRReviewResult> {
    if (!taskId) return result;
    const sectionMatch = taskBody.match(
      /##+\s*Files\s*\/\s*paths[^\n]*\n([\s\S]*?)(?=\n##+\s|$)/i,
    );
    if (!sectionMatch) return result;

    const { parseFilesPathsRawItems, extractPathToken } =
      await import('../groom/groomLoad');
    const newMigrationEntries = parseFilesPathsRawItems(sectionMatch[1])
      .filter((e) => e.isNew)
      .map((e) => {
        const token = extractPathToken(e.raw);
        if (!token || !isMigrationPath(token)) return null;
        const parts = parseMigrationEntryDirSuffix(token);
        return parts
          ? { raw: e.raw, dir: parts.dir, suffix: parts.suffix }
          : null;
      })
      .filter(
        (e): e is { raw: string; dir: string; suffix: string } => e !== null,
      );
    if (newMigrationEntries.length === 0) return result;

    const diffMigrationPaths = parseDiffFiles(diffText).filter(isMigrationPath);

    // Evaluate every *(new)* entry first and AND the verdicts together —
    // overrideFilesPathsDimension overwrites `passed` per call (last call
    // wins), so calling it once per entry would let a later matching entry
    // silently clobber an earlier entry's mismatch. A single call with the
    // aggregated pass/fail and all notes concatenated keeps the dimension
    // failed if any *(new)* entry mismatches its reservation.
    const checks: { passed: boolean; note: string }[] = [];
    let anyOvertaken = false;
    for (const entry of newMigrationEntries) {
      const reservation = getReservationForTaskDirSuffix(
        taskId,
        entry.dir,
        entry.suffix,
      );
      if (!reservation) continue; // nothing reserved for this entry — leave to LLM judgement

      const shippedPath = diffMigrationPaths.find((p) => {
        const parts = parseMigrationParts(p);
        return (
          parts !== null &&
          parts.dir === entry.dir &&
          parts.suffix === entry.suffix
        );
      });
      const shippedNumber = shippedPath
        ? Number(parseMigrationParts(shippedPath)!.number)
        : null;

      if (shippedNumber === reservation.number) {
        checks.push({
          passed: true,
          note: `Deterministic migration-reservation check: ${entry.dir}${entry.suffix} ships as ${shippedPath}, matching its reserved number ${reservation.number} — override pass.`,
        });
      } else {
        const conflicting =
          shippedNumber !== null
            ? getReservationByNumber(reservation.project, shippedNumber)
            : undefined;
        const overtaken =
          conflicting !== undefined &&
          conflicting.taskId !== taskId &&
          isTaskAlreadyMerged(conflicting.taskId);
        if (overtaken) anyOvertaken = true;
        checks.push({
          passed: false,
          note: `Deterministic migration-reservation check: expected migration number ${reservation.number} (reserved) for ${entry.dir}${entry.suffix} but the PR ships ${shippedNumber ?? 'no matching migration file'}${
            overtaken
              ? `, already claimed and merged by task ${conflicting!.taskId} — out-of-band overtake`
              : ''
          } — override fail.`,
        });
      }
    }
    if (checks.length === 0) return result;

    const allPassed = checks.every((c) => c.passed);
    const note = checks.map((c) => c.note).join(' ');
    const overridden = overrideFilesPathsDimension(result, allPassed, note);
    if (anyOvertaken) {
      return {
        ...overridden,
        escalate: true,
        escalationReason: overridden.escalationReason
          ? `${overridden.escalationReason} | ${note}`
          : note,
        migrationReservationOvertaken: true,
      };
    }
    return overridden;
  }

  private async fetchTaskBodyBestEffort(
    projectId: string,
    taskId: string | null | undefined,
  ): Promise<string> {
    if (!taskId) return '';
    try {
      return await this.resolveBackend(projectId).fetchTaskPage(taskId);
    } catch (e) {
      logger.warn(
        `[PRReviewService] fetchTaskPage failed for migration-renumber check (task ${taskId}): ${(e as Error).message}`,
      );
      return '';
    }
  }

  /**
   * `prIntent`, when present, is the approved ops.prIntent this PR was
   * opened for (see getPRIntentForPR in db/queries.ts) — the Ops rubric
   * variant: the "Changed files" dimension is evaluated against its declared
   * scope instead of the task specification's Files/paths affected section.
   */
  buildPrompt(
    pr: PullRequest,
    diff: PRDiff,
    taskBody: string,
    prIntent?: OpsPrIntentPayload | null,
  ): string {
    const prIntentSection = prIntent
      ? `\n## Approved PR Intent (Ops)
Title: ${prIntent.title}
Declared scope: ${prIntent.scope}
Reason: ${prIntent.reason}
\nThis PR was opened by an Ops session against the operator-approved declaration above — evaluate the "Changed files" dimension against it, not the task specification's Files/paths section.\n`
      : '';
    const schemaBlock = prIntent
      ? buildReviewJsonSchemaBlock(OPS_PR_INTENT_FILES_DIMENSION_GUIDANCE)
      : REVIEW_JSON_SCHEMA_BLOCK;
    return `You are a code reviewer. Compare the following GitHub PR against its task specification.

## PR Metadata
Title: ${pr.title}
Description: ${pr.body ?? '(none)'}
Head branch: ${pr.headBranch}

## PR Diff
${diff.diff}

## Task Specification
${taskBody}
${prIntentSection}

## Your task
${schemaBlock}`;
  }

  parseReviewResult(
    events: SessionEvent[],
    prNumber: number,
    repo: string,
    sessionId?: string,
  ): PRReviewResult {
    // Only use text blocks from the LAST assistant message to avoid pollution
    // from earlier tool-call assistant events.
    let lastAssistantContent: Array<Record<string, unknown>> | null = null;
    // Track whether the session ended with status_category:"review_ready" — a signal
    // that the model completed its review turn even if the last assistant message was
    // tool-call-only (no text block).
    let hasReviewReadyResult = false;

    for (const ev of events) {
      try {
        const parsed = JSON.parse(ev.payload) as Record<string, unknown>;
        if (parsed.type === 'assistant') {
          const msg = parsed.message as Record<string, unknown> | undefined;
          const content = msg?.content as
            | Array<Record<string, unknown>>
            | undefined;
          if (content) lastAssistantContent = content;
        } else if (
          parsed.type === 'result' &&
          parsed.status_category === 'review_ready'
        ) {
          hasReviewReadyResult = true;
        }
      } catch {
        // Skip unparseable events
      }
    }

    const textParts: string[] = [];
    if (lastAssistantContent) {
      for (const block of lastAssistantContent) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
    }

    const combined = textParts.join('').trim();
    const parsed = this.tryParseVerdict(combined);
    if (parsed) {
      return {
        prNumber,
        repo,
        verdict: parsed.verdict,
        dimensions: parsed.dimensions,
        summary: parsed.summary,
        reviewedAt: new Date().toISOString(),
        ...(parsed.manualItemsForHuman
          ? { manualItemsForHuman: parsed.manualItemsForHuman }
          : {}),
        ...(parsed.escalate
          ? {
              escalate: parsed.escalate,
              escalationReason: parsed.escalationReason,
            }
          : {}),
      };
    }

    // If the last assistant message was tool-call-only (no text blocks) or the
    // session ended with status_category:"review_ready" (confirmed the review
    // completed), scan all events in reverse to find the most recent text-block
    // verdict from an earlier assistant turn.
    if (textParts.length === 0 || hasReviewReadyResult) {
      for (let i = events.length - 1; i >= 0; i--) {
        const recovered = this.tryParseVerdictFromRawEvent(
          events[i].payload,
          prNumber,
          repo,
        );
        if (recovered) return recovered;
      }
    }

    if (sessionId) {
      recordEvent({
        event_type: 'review_verdict_parse_fallback',
        actor_type: 'system',
        actor_id: sessionId,
        task_id: null,
        payload: { sessionId, prNumber, repo },
      });
    }

    return {
      prNumber,
      repo,
      verdict: 'incomplete',
      dimensions: [],
      summary: `Failed to parse Claude output as JSON. Raw output: ${combined.slice(0, 500)}`,
      reviewedAt: new Date().toISOString(),
    };
  }

  private async withFetchRetry<T>(
    fn: () => Promise<T>,
    sleep: (ms: number) => Promise<void>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!isTransientFetchError(e)) throw e;
        lastError = e;
        if (attempt < RETRY_DELAYS.length) {
          await sleep(RETRY_DELAYS[attempt]);
        }
      }
    }
    throw new FetchRetryExhaustedError(
      lastError instanceof Error ? lastError : new Error(String(lastError)),
    );
  }
}
