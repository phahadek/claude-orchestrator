import { logger } from '../logger';
import {
  getProjectByGithubRepo,
  getProjectById,
  runtimeSettings,
} from '../config';
import type { ProjectConfig } from '../config';
import { typedGetSetting } from '../config/settings';
import {
  setPRReviewResult,
  getPRByNumber,
  getPRBySessionId,
  setPendingPush,
  setPauseReason,
  getLocalBranchBySession,
  setLocalBranchPauseReason,
  getSession,
  addAutofixSha,
  consumeAutofixSha as dbConsumeAutofixSha,
  insertPendingReviewSync,
  deletePendingReviewSync,
  getAllPendingReviewSyncs,
  getLatestTestRequestRun,
  upsertDepthReviewVerdict,
  getDepthReviewVerdict,
  hasAnalyzeResultForSha,
  upsertAnalyzeResult,
  getAnalyzeResult,
  setPreReviewStage,
  enqueueFeedbackItem,
  hasDispositionReplyBeenPosted,
  recordDispositionReply,
} from '../db/queries';
import { syncToOrigin } from './PRFileReverter';
import type {
  PRReviewService,
  PRReviewResult,
  WorkItem,
  BaselineEscalationMatch,
} from './PRReviewService';
import {
  FetchRetryExhaustedError,
  matchBaselineEscalationFloor,
} from './PRReviewService';
import type {
  DepthReviewService,
  DepthReviewResult,
} from './DepthReviewService';
import { SIZE_DIMENSION_NAME as DEPTH_SIZE_DIMENSION_NAME } from './DepthReviewService';
import type { AutoMerger } from './AutoMerger';
import { parsePauseReason } from '../db/pauseReason';
import type { SessionManager } from '../session/SessionManager';
import type { GitHubClient } from './GitHubClient';
import { parseDiffFiles } from './GitHubClient';
import type { ReviewJob, FlakeRecoveryOutcome } from './types';
import type { DiffSource } from './DiffSource';
import { GitHubDiffSource, LocalDiffSource } from './DiffSource';
import { formatReviewFeedback, formatCIFailureFeedback } from './reviewUtils';
import type { DispositionsParsedPayload } from './types';
import { runVerifyAsGate, type VerifyResult } from '../orchestration/verifyRunner';
import {
  filterVerifyFailureByBaseHealth,
  renderBaseAttributableFilterDigest,
} from '../orchestration/baseAttributableFilter';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { loadAutofixCommands, runAutofix } from '../session/autofix-runner';
import { runTestCommands } from '../session/test-runner';
import { runFilePollutionCheck } from '../session/filePollutionCheck';
import { computeWholeTreeContentHash } from '../session/analyzeGating';
import { runProjectTestRequest } from '../orchestration/testRequestLane';
import { recordEvent } from '../audit/AuditLog';
import { opensPr } from '../session/sessionPredicates';
import type { ServerMessage } from '../ws/types';
import { PreReviewPipeline } from './PreReviewPipeline';

function getMaxReviewIterations(): number {
  return typedGetSetting('max_review_iterations');
}

interface LocalBranchJob {
  type: 'local_branch';
  localBranchId: number;
  projectId: string;
  sessionId: string;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  taskId: string | null;
  contextUrl: string;
}

type QueuedJob = (ReviewJob & { type?: 'pr' }) | LocalBranchJob;

const STALL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const STALL_CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
// Backstop ceiling on the depth-review dispatch, above DepthReviewService's
// own 15-minute internal timeout — see runDepthReviewWithCeiling().
const DEPTH_REVIEW_DISPATCH_CEILING_MS = 20 * 60 * 1000; // 20 minutes
// Bounds how many times a non-size depth finding can be routed to the
// implementing session on an unchanged head SHA (see dispatchDepthReview's
// routeCount tracking) — beyond this, a session that isn't fixing it
// escalates instead of cycling forever.
const MAX_DEPTH_REVIEW_ROUTE_ATTEMPTS = 2;

export class ReviewOrchestrator {
  private queue: QueuedJob[] = [];
  private running = 0;
  /** PR keys ("prNumber:repo") for reviews currently executing — enforces per-PR serialization. */
  private inFlightPRKeys = new Set<string>();
  /** Start timestamps (ms) for in-flight reviews keyed by "prNumber:repo" — used by stall detector. */
  private inFlightStartTimes = new Map<string, number>();
  /** In-flight post-revert worktree sync promises, keyed by "prNumber:repo". */
  private pendingSyncs = new Map<string, Promise<void>>();
  /** Resolves once all incomplete pending_review_sync rows from the previous run are retried. */
  readonly bootReady: Promise<void>;
  private stallDetectorInterval: ReturnType<typeof setInterval> | null = null;
  private preReviewPipeline: PreReviewPipeline;
  /**
   * Optional reference to the depth-review pass — the second, separate
   * review dispatched only after a PR's conformance verdict reaches
   * approved (see runDepthReviewPass). Set via setDepthReviewService() after
   * both services are constructed (server.ts), mirroring the
   * mergeWatcher/autoMerger wiring on PRReviewService. Left unset in most
   * tests, which is fine: the depth pass fails open, so an unwired instance
   * behaves exactly like a depth-review timeout — no escalation, merge
   * proceeds on conformance approval alone.
   */
  private depthReviewService?: DepthReviewService;

  setDepthReviewService(service: DepthReviewService): void {
    this.depthReviewService = service;
  }

  /**
   * Optional reference to AutoMerger, used to re-drive the merge after
   * dispatchDepthReview clears the depth_review_pending hold it inherits
   * from PRReviewService.handleApprovedVerdict. Set via setAutoMerger()
   * after both services are constructed (server.ts), mirroring
   * PRReviewService's own autoMerger wiring.
   */
  private autoMerger?: AutoMerger;

  setAutoMerger(merger: AutoMerger): void {
    this.autoMerger = merger;
  }

  constructor(
    private reviewService: PRReviewService,
    private sessionManager: SessionManager,
    private enabled: boolean = true,
    private github?: GitHubClient,
    stallCheckIntervalMs: number = STALL_CHECK_INTERVAL_MS,
    stallTimeoutMs: number = STALL_TIMEOUT_MS,
  ) {
    this.preReviewPipeline = new PreReviewPipeline(sessionManager, github);
    sessionManager.on('pr_opened', (job: ReviewJob) => this.onPrOpened(job));
    sessionManager.on('message', (msg: ServerMessage) => this.onMessage(msg));
    sessionManager.on(
      'dispositions_parsed',
      (payload: unknown) =>
        void this.handleDispositions(payload as DispositionsParsedPayload),
    );
    sessionManager.on(
      'revert_sync_registered',
      (payload: {
        prNumber: number;
        repo: string;
        syncPromise: Promise<void>;
      }) => {
        this.registerRevertSync(
          payload.prNumber,
          payload.repo,
          payload.syncPromise,
        );
      },
    );
    this.bootReady = this.rehydratePendingSyncs();
    this.startStallDetector(stallCheckIntervalMs, stallTimeoutMs);
  }

  /** Release all background timers. Call when shutting down the server. */
  destroy(): void {
    if (this.stallDetectorInterval) {
      clearInterval(this.stallDetectorInterval);
      this.stallDetectorInterval = null;
    }
  }

  private startStallDetector(intervalMs: number, timeoutMs: number): void {
    const handle = setInterval(() => {
      const now = Date.now();
      for (const [key, startTime] of this.inFlightStartTimes) {
        const elapsedMs = now - startTime;
        if (elapsedMs > timeoutMs) {
          logger.error(
            `[ReviewOrchestrator] STALL DETECTED for ${key} — review has been running for ${Math.round(elapsedMs / 60000)} min. Force-clearing slot.`,
          );
          this.inFlightPRKeys.delete(key);
          this.inFlightStartTimes.delete(key);
          this.running = Math.max(0, this.running - 1);
          void this.drain();
        }
      }
    }, intervalMs);
    // Don't keep the Node process alive for the stall detector alone.
    handle.unref();
    this.stallDetectorInterval = handle;
  }

  /**
   * Re-attempt each incomplete pending_review_sync row left over from a previous
   * run. For each row, performs an idempotent git fetch + reset so the worktree
   * reflects the remote branch state, then clears the row. If the revert push
   * had already completed on GitHub before the restart, the fetch/reset is a
   * no-op. Arms the in-memory pendingSyncs map so executeReview can await the
   * operations before fetching the diff.
   */
  async rehydratePendingSyncs(): Promise<void> {
    const pending = getAllPendingReviewSyncs();
    if (pending.length === 0) return;

    await Promise.all(
      pending.map(async ({ pr_number, repo }) => {
        const key = `${pr_number}:${repo}`;
        const syncPromise = (async () => {
          try {
            const prRow = getPRByNumber(pr_number, repo);
            if (prRow?.session_id && prRow.head_branch) {
              const session = getSession(prRow.session_id);
              if (session?.worktree_path) {
                await syncToOrigin(session.worktree_path, prRow.head_branch);
              }
            }
          } catch (e) {
            logger.warn(
              `[ReviewOrchestrator] boot-retry sync failed for PR #${pr_number} (${repo}): ${e}`,
            );
          }
        })();
        const tracked = syncPromise.finally(() => {
          deletePendingReviewSync(pr_number, repo);
        });
        this.pendingSyncs.set(key, tracked);
        await tracked;
      }),
    );
  }

  /** Store a pending sync promise so executeReview can await it before fetching the diff. */
  registerRevertSync(
    prNumber: number,
    repo: string,
    syncPromise: Promise<void>,
  ): void {
    const key = `${prNumber}:${repo}`;
    insertPendingReviewSync(prNumber, repo);
    const tracked = syncPromise.finally(() => {
      deletePendingReviewSync(prNumber, repo);
    });
    this.pendingSyncs.set(key, tracked);
  }

  private onPrOpened(job: ReviewJob): void {
    if (!this.enabled) {
      logger.info(
        `[ReviewOrchestrator] pr_opened received for PR #${job.prNumber} (${job.repo}) — orchestrator disabled, skipping`,
      );
      return;
    }
    if (!job.taskId) {
      logger.warn(
        `[ReviewOrchestrator] PR #${job.prNumber} has no Notion task — skipping`,
      );
      return;
    }
    logger.info(
      `[ReviewOrchestrator] pr_opened received for PR #${job.prNumber} (${job.repo}) — queueing (queue depth before: ${this.queue.length})`,
    );
    this.queue.push(job);
    void this.drain();
  }

  private onMessage(msg: ServerMessage): void {
    if (!this.enabled) return;
    if (msg.type === 'session_ended') {
      this.onSessionEnded(msg.sessionId);
      return;
    }
    if (msg.type !== 'local_branch_submitted') return;

    const { projectId, sessionId, branchName, baseBranch } = msg;

    const sessionRow = getSession(sessionId);
    if (!sessionRow?.worktree_path) {
      logger.warn(
        `[ReviewOrchestrator] local_branch_submitted for session ${sessionId} — no worktree_path, skipping`,
      );
      return;
    }

    const localBranchRow = getLocalBranchBySession(sessionId);
    if (!localBranchRow) {
      logger.warn(
        `[ReviewOrchestrator] local_branch_submitted for session ${sessionId} — no local_branch row found, skipping`,
      );
      return;
    }

    const project = getProjectById(projectId);
    const contextUrl = project?.contextUrl ?? '';

    this.queue.push({
      type: 'local_branch',
      localBranchId: localBranchRow.id,
      projectId,
      sessionId,
      branchName,
      baseBranch,
      worktreePath: sessionRow.worktree_path,
      taskId: sessionRow.task_id,
      contextUrl,
    });
    void this.drain();
  }

  private prKey(job: QueuedJob): string | null {
    if (job.type === 'local_branch') return null;
    const prJob = job as ReviewJob;
    return `${prJob.prNumber}:${prJob.repo}`;
  }

  async drain(): Promise<void> {
    await this.bootReady;
    while (
      this.running < runtimeSettings.auto_review_concurrency &&
      this.queue.length > 0
    ) {
      // Find the first job not blocked by per-PR serialization.
      let jobIndex = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const key = this.prKey(this.queue[i]);
        if (key === null || !this.inFlightPRKeys.has(key)) {
          jobIndex = i;
          break;
        }
      }
      if (jobIndex === -1) break; // all remaining jobs are blocked by in-flight reviews

      const [job] = this.queue.splice(jobIndex, 1);
      const key = this.prKey(job);

      this.running++;
      if (key !== null) {
        this.inFlightPRKeys.add(key);
        this.inFlightStartTimes.set(key, Date.now());
      }

      if (job.type === 'local_branch') {
        const lbJob = job as LocalBranchJob;
        logger.info(
          `[ReviewOrchestrator] drain: starting local-branch review for ${lbJob.branchName} (running: ${this.running}/${runtimeSettings.auto_review_concurrency})`,
        );
      } else {
        const prJob = job as ReviewJob;
        logger.info(
          `[ReviewOrchestrator] drain: starting review for PR #${prJob.prNumber} (${prJob.repo}) (running: ${this.running}/${runtimeSettings.auto_review_concurrency})`,
        );
      }

      void (async () => {
        try {
          if (job.type === 'local_branch') {
            await this.executeLocalBranchReview(job);
          } else {
            await this.executeReview(job as ReviewJob);
          }
        } catch (e) {
          if (job.type === 'local_branch') {
            logger.error(
              `[ReviewOrchestrator] review failed for local branch ${(job as LocalBranchJob).branchName}:`,
              e,
            );
          } else {
            const prJob = job as ReviewJob;
            logger.error(
              `[ReviewOrchestrator] review failed for PR #${prJob.prNumber}:`,
              e,
            );
          }
        } finally {
          this.running--;
          if (key !== null) {
            this.inFlightPRKeys.delete(key);
            this.inFlightStartTimes.delete(key);
          }
          void this.drain();
        }
      })();
    }
  }

  /**
   * Runs the autofix + file-pollution-check pipeline for a PR.
   * Called from both executeReview (first review) and the server.ts
   * push_detected re-review path so every push goes through the same pipeline.
   */
  async runAutofixPipeline(
    prNumber: number,
    repo: string,
    taskId: string | null,
  ): Promise<{ success: boolean; summary: string }> {
    const project = getProjectByGithubRepo(repo);
    if (!project) return { success: true, summary: 'no project — skipped' };

    const autofixCommands = loadAutofixCommands(project.projectDir);
    if (autofixCommands.length === 0)
      return { success: true, summary: 'no autofix commands — skipped' };

    const autofixConfig = loadOrchestratorConfig(project.projectDir);

    this.sessionManager.emit('message', {
      type: 'autofix_started',
      prNumber,
      repo,
    });
    setPreReviewStage(prNumber, repo, 'autofix');

    const prRow = getPRByNumber(prNumber, repo);
    const worktreePath = prRow?.session_id
      ? (getSession(prRow.session_id)?.worktree_path ?? '')
      : '';

    let autofixSuccess = true;
    let autofixSummary = 'no worktree available — autofix skipped';

    if (worktreePath) {
      try {
        const result = await runAutofix(
          worktreePath,
          project.projectDir,
          autofixCommands,
          (msg) =>
            logger.info(`[ReviewOrchestrator] autofix PR #${prNumber}: ${msg}`),
          'dev',
          autofixConfig.autofix_skip_ci,
        );
        autofixSuccess = result.success;
        autofixSummary = result.summary;
        if (result.commitSha) {
          addAutofixSha(prNumber, repo, result.commitSha);
          if (prRow?.session_id && result.touchedFiles?.length) {
            this.sessionManager.addToRevertLock(
              prRow.session_id,
              result.touchedFiles,
            );
          }
          if (this.github) {
            const pollutionResult = await runFilePollutionCheck({
              github: this.github,
              worktreePath,
              repo,
              prNumber,
              baseBranch: prRow?.base_branch ?? 'dev',
              sessionId: prRow?.session_id ?? null,
              projectId: project.id,
              taskId,
              skipCi: autofixConfig.autofix_skip_ci,
              onReverted: (files) => {
                if (prRow?.session_id) {
                  this.sessionManager.addToRevertLock(prRow.session_id, files);
                }
              },
            });
            if (pollutionResult.revertCommitSha) {
              addAutofixSha(prNumber, repo, pollutionResult.revertCommitSha);
            }
          }
        }
      } catch (err) {
        autofixSuccess = false;
        autofixSummary = `autofix threw: ${String(err)}`;
        logger.error(
          `[ReviewOrchestrator] autofix error for PR #${prNumber}:`,
          err,
        );
      }
    }

    this.sessionManager.emit('message', {
      type: 'autofix_complete',
      prNumber,
      repo,
      success: autofixSuccess,
      summary: autofixSummary,
    });

    if (!autofixSuccess) {
      logger.warn(
        `[ReviewOrchestrator] autofix failed for PR #${prNumber}: ${autofixSummary}`,
      );
    }

    return { success: autofixSuccess, summary: autofixSummary };
  }

  /**
   * Returns true (and consumes the entry) when the given SHA is the autofix
   * commit that was pushed during the last runAutofixPipeline() for this PR.
   * Used by the push_detected handler to skip re-reviews for autofix-only pushes
   * so they do not count against the iteration cap.
   */
  consumeAutofixSha(prNumber: number, repo: string, sha: string): boolean {
    return dbConsumeAutofixSha(prNumber, repo, sha);
  }

  /** Returns true when a review is actively executing or queued-but-blocked for this PR. */
  isReviewInFlight(prNumber: number, repo: string): boolean {
    return this.inFlightPRKeys.has(`${prNumber}:${repo}`);
  }

  /**
   * Enqueue a review for the given PR via the same path as pr_opened.
   * Skips when the orchestrator is disabled or the job has no taskId.
   * Returns whether the job was actually queued, so callers can tell a real
   * dispatch apart from a silent no-op.
   */
  enqueueReview(job: ReviewJob): boolean {
    if (!this.enabled) return false;
    if (!job.taskId) return false;
    logger.info(
      `[ReviewOrchestrator] enqueueReview for PR #${job.prNumber} (${job.repo}) — queueing (queue depth before: ${this.queue.length})`,
    );
    this.queue.push(job);
    void this.drain();
    return true;
  }

  /**
   * Run the configured test: commands for a PR's head SHA.
   * Deduplicates against the shared F2 content-hash cache
   * (test_request_runs, the same table the test.request lane and
   * PreReviewPipeline.buildTestsStage write into): if an identical
   * whole-tree content hash already has a result, skips execution. On a
   * miss, runs via runProjectTestRequest, which durably records the result
   * into test_request_runs for F2 to consult — so a push doesn't run tests
   * twice for the same content.
   */
  async runTestPipeline(
    prNumber: number,
    repo: string,
    headSha: string,
    worktreePath: string,
    commands: string[] | undefined,
    timeoutSec: number,
    maxRssMb = 0,
    failFast = true,
  ): Promise<void> {
    if (!commands?.length || !headSha) return;

    const project = getProjectByGithubRepo(repo);
    if (!project) return;

    const contentHash = await computeWholeTreeContentHash(worktreePath);
    if (contentHash && getLatestTestRequestRun(project.id, contentHash)) {
      logger.info(
        `[ReviewOrchestrator] tests content-cache hit for PR #${prNumber} SHA ${headSha.slice(0, 7)} — skipping`,
      );
      return;
    }

    logger.info(
      `[ReviewOrchestrator] running tests for PR #${prNumber} SHA ${headSha.slice(0, 7)} (timeout ${timeoutSec}s)`,
    );

    const { passed } = contentHash
      ? await runProjectTestRequest({
          projectId: project.id,
          contentHash,
          worktreePath,
          commands,
          timeoutSec,
          maxRssMb,
          sessionId: null,
          runOrigin: 'pr_pipeline',
        })
      : await runTestCommands(
          worktreePath,
          commands,
          timeoutSec,
          (msg) =>
            logger.info(`[ReviewOrchestrator] test PR #${prNumber}: ${msg}`),
          { maxRssMb, failFast },
        );

    logger.info(
      `[ReviewOrchestrator] tests ${passed ? 'PASSED' : 'FAILED'} for PR #${prNumber} SHA ${headSha.slice(0, 7)}`,
    );
  }

  /**
   * Actuate a verified-flaky disposition on the F2 gate — delegates to
   * PreReviewPipeline.rerunFlakyTests. Exposed here so PRMergeWatcher (which
   * holds a ReviewOrchestrator reference, not a PreReviewPipeline one) can
   * drive same-SHA F2 re-runs.
   */
  async rerunFlakyTests(
    prNumber: number,
    repo: string,
    headSha: string,
    worktreePath: string,
    project: ProjectConfig,
  ): Promise<{
    outcome: FlakeRecoveryOutcome;
    passed: boolean;
    output: string;
  } | null> {
    return this.preReviewPipeline.rerunFlakyTests(
      prNumber,
      repo,
      headSha,
      worktreePath,
      project,
    );
  }

  /**
   * Actuate a verified-flaky disposition on the analyze gate — delegates to
   * PreReviewPipeline.rerunFlakyAnalyze. Exposed here so PRMergeWatcher (which
   * holds a ReviewOrchestrator reference, not a PreReviewPipeline one) can
   * drive same-SHA analyze re-runs.
   */
  async rerunFlakyAnalyze(
    prNumber: number,
    repo: string,
    headSha: string,
    worktreePath: string,
    project: ProjectConfig,
  ): Promise<{
    outcome: FlakeRecoveryOutcome;
    passed: boolean;
    output: string;
  } | null> {
    return this.preReviewPipeline.rerunFlakyAnalyze(
      prNumber,
      repo,
      headSha,
      worktreePath,
      project,
    );
  }

  /**
   * Run the configured analyze: commands for a PR's head SHA.
   * Deduplicates: if a result already exists for this SHA, returns the cached result.
   * Persists { passed, output } keyed by (prNumber, repo, sha).
   * Returns { passed, output } so the caller can act on failure.
   */
  async runAnalyzePipeline(
    prNumber: number,
    repo: string,
    headSha: string,
    worktreePath: string,
    commands: string[],
    timeoutSec: number,
    maxRssMb = 0,
    failFast = true,
  ): Promise<{ passed: boolean; output: string }> {
    if (!commands.length || !headSha) return { passed: true, output: '' };

    if (hasAnalyzeResultForSha(prNumber, repo, headSha)) {
      logger.info(
        `[ReviewOrchestrator] analyze already ran for PR #${prNumber} SHA ${headSha.slice(0, 7)} — returning cached result`,
      );
      const cached = getAnalyzeResult(prNumber, repo, headSha);
      return { passed: cached?.passed === 1, output: cached?.output ?? '' };
    }

    logger.info(
      `[ReviewOrchestrator] running analyze for PR #${prNumber} SHA ${headSha.slice(0, 7)} (timeout ${timeoutSec}s)`,
    );

    const result = await runTestCommands(
      worktreePath,
      commands,
      timeoutSec,
      (msg) =>
        logger.info(`[ReviewOrchestrator] analyze PR #${prNumber}: ${msg}`),
      { maxRssMb, failFast },
    );
    const { passed, output } = result;

    upsertAnalyzeResult(
      prNumber,
      repo,
      headSha,
      passed,
      output,
      !!(result.timedOut || result.oomKilled),
    );

    logger.info(
      `[ReviewOrchestrator] analyze ${passed ? 'PASSED' : 'FAILED'} for PR #${prNumber} SHA ${headSha.slice(0, 7)}`,
    );

    return { passed, output };
  }

  /**
   * Drive review-thread reply/resolve actions based on dispositions emitted by
   * the coding session. Called when the session emits a `dispositions_parsed` event.
   */
  async handleDispositions(payload: DispositionsParsedPayload): Promise<void> {
    if (!this.github) return;
    const { prNumber, repo, headSha, dispositions } = payload;
    const shaLabel = headSha ? headSha.slice(0, 7) : 'unknown';

    for (const d of dispositions) {
      const commentIdStr = String(d.comment_id);
      if (
        hasDispositionReplyBeenPosted(
          prNumber,
          repo,
          commentIdStr,
          d.disposition,
        )
      ) {
        logger.debug(
          `[ReviewOrchestrator] disposition: reply already posted for comment_id ${d.comment_id} (${d.disposition}) — skipping duplicate`,
        );
        continue;
      }
      let threadId: string | null;
      try {
        threadId = await this.github.findThreadByCommentId(
          d.comment_id,
          prNumber,
          repo,
        );
      } catch (err) {
        logger.warn(
          `[ReviewOrchestrator] disposition: findThreadByCommentId failed for comment_id ${d.comment_id}: ${(err as Error).message}`,
        );
        continue;
      }
      if (!threadId) {
        logger.warn(
          `[ReviewOrchestrator] disposition: no thread found for comment_id ${d.comment_id} on PR #${prNumber} — skipping`,
        );
        continue;
      }
      try {
        if (d.disposition === 'addressed') {
          const reasonSuffix = d.reason ? `: ${d.reason}` : '';
          await this.github.addPullRequestReviewThreadReply(
            threadId,
            `Addressed in ${shaLabel}${reasonSuffix}`,
          );
          await this.github.resolveReviewThread(threadId);
        } else if (d.disposition === 'wont_fix') {
          await this.github.addPullRequestReviewThreadReply(
            threadId,
            `Won't fix: ${d.reason ?? ''}`,
          );
        } else if (d.disposition === 'out_of_scope') {
          await this.github.addPullRequestReviewThreadReply(
            threadId,
            `Out of scope for this PR: ${d.reason ?? ''}`,
          );
        }
        recordDispositionReply(prNumber, repo, commentIdStr, d.disposition);
        logger.info(
          `[ReviewOrchestrator] disposition: ${d.disposition} for comment_id ${d.comment_id} → thread ${threadId}`,
        );
      } catch (err) {
        logger.warn(
          `[ReviewOrchestrator] disposition action failed for comment_id ${d.comment_id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Filters a failed verify run against the current base-branch health when
   * verify's own failing command produced a structured report (see
   * baseAttributableFilter.ts's filterVerifyFailureByBaseHealth) — a base
   * branch break the test.request lane has already confirmed must not also
   * fail the pre-review verify gate. Records a visible (non-blocking)
   * base_attributable_test_excluded pause reason whenever filtering
   * applies, then returns a VerifyResult a caller can treat exactly like
   * runVerifyAsGate's own return: `passed: true` once every failing test is
   * base-attributable, or `passed: false` with `truncatedOutput` narrowed
   * to only the non-base-attributable remainder otherwise. Returns `result`
   * unchanged — including on filter-lookup errors — when no structured
   * report was parseable or the base probe couldn't attribute anything.
   */
  private async applyVerifyBaseAttributionFilter(
    project: ProjectConfig,
    localBranchId: number,
    result: VerifyResult,
  ): Promise<VerifyResult> {
    if (result.passed) return result;
    let filtered: Awaited<ReturnType<typeof filterVerifyFailureByBaseHealth>>;
    try {
      filtered = await filterVerifyFailureByBaseHealth(
        project,
        result.structuredResult,
      );
    } catch (err) {
      logger.warn(
        `[ReviewOrchestrator] verify base-attributable filter failed for local branch ${localBranchId}: ${err instanceof Error ? err.message : err}`,
      );
      return result;
    }
    if (!filtered || filtered.outcome === 'unfiltered') return result;

    const digest = renderBaseAttributableFilterDigest(filtered);
    setLocalBranchPauseReason(
      localBranchId,
      'base_attributable_test_excluded',
      digest.slice(0, 1000),
    );
    if (filtered.passed) {
      return { passed: true };
    }
    return {
      passed: false,
      failedCommand: result.failedCommand,
      truncatedOutput: digest,
    };
  }

  private async executeLocalBranchReview(job: LocalBranchJob): Promise<void> {
    const project = getProjectById(job.projectId);
    if (project) {
      const config = loadOrchestratorConfig(project.projectDir);
      const verifyResult = await this.applyVerifyBaseAttributionFilter(
        project,
        job.localBranchId,
        await runVerifyAsGate(
          job.worktreePath,
          config.verify,
          config.test_report_glob,
        ),
      );
      if (!verifyResult.passed) {
        const autofixCommands = loadAutofixCommands(project.projectDir);
        if (autofixCommands.length > 0) {
          try {
            const autofixResult = await runAutofix(
              job.worktreePath,
              project.projectDir,
              autofixCommands,
              (msg) =>
                logger.info(
                  `[ReviewOrchestrator] autofix local branch ${job.branchName}: ${msg}`,
                ),
              'dev',
              config.autofix_skip_ci,
            );
            if (autofixResult.commitSha) {
              recordEvent({
                event_type: 'autofix_for_ci_failure',
                actor_type: 'system',
                task_id: job.taskId ?? null,
                payload: {
                  pr_number: job.localBranchId,
                  commit_sha: autofixResult.commitSha,
                  failing_checks: verifyResult.failedCommand
                    ? [verifyResult.failedCommand]
                    : [],
                  source: 'verify',
                },
              });
              // Re-run verify to see if autofix resolved it
              const retryResult = await this.applyVerifyBaseAttributionFilter(
                project,
                job.localBranchId,
                await runVerifyAsGate(
                  job.worktreePath,
                  config.verify,
                  config.test_report_glob,
                ),
              );
              if (retryResult.passed) {
                // Autofix fixed the gate — fall through to AI review
              } else {
                setLocalBranchPauseReason(job.localBranchId, 'ci_failing');
                await this.sessionManager.enqueueFeedback(
                  job.sessionId,
                  'ci-failure',
                  formatCIFailureFeedback({
                    source: 'verify',
                    failedCommand: retryResult.failedCommand,
                    truncatedOutput: retryResult.truncatedOutput,
                  }),
                );
                return;
              }
            } else {
              setLocalBranchPauseReason(job.localBranchId, 'ci_failing');
              await this.sessionManager.enqueueFeedback(
                job.sessionId,
                'ci-failure',
                formatCIFailureFeedback({
                  source: 'verify',
                  failedCommand: verifyResult.failedCommand,
                  truncatedOutput: verifyResult.truncatedOutput,
                }),
              );
              return;
            }
          } catch (err) {
            logger.warn(
              `[ReviewOrchestrator] autofix error for local branch ${job.branchName}:`,
              err,
            );
            setLocalBranchPauseReason(job.localBranchId, 'ci_failing');
            await this.sessionManager.enqueueFeedback(
              job.sessionId,
              'ci-failure',
              formatCIFailureFeedback({
                source: 'verify',
                failedCommand: verifyResult.failedCommand,
                truncatedOutput: verifyResult.truncatedOutput,
              }),
            );
            return;
          }
        } else {
          setLocalBranchPauseReason(job.localBranchId, 'ci_failing');
          await this.sessionManager.enqueueFeedback(
            job.sessionId,
            'ci-failure',
            formatCIFailureFeedback({
              source: 'verify',
              failedCommand: verifyResult.failedCommand,
              truncatedOutput: verifyResult.truncatedOutput,
            }),
          );
          return;
        }
      }
    }

    const diffSource = new LocalDiffSource(
      job.worktreePath,
      job.baseBranch,
      job.branchName,
    );

    const workItem: WorkItem = {
      type: 'local_branch',
      localBranchId: job.localBranchId,
      branchName: job.branchName,
      baseBranch: job.baseBranch,
      sessionId: job.sessionId,
      taskId: job.taskId,
    };

    let result: PRReviewResult;
    try {
      result = await this.reviewService.reviewPR(
        workItem,
        diffSource,
        job.projectId,
        job.contextUrl,
      );
    } catch (e) {
      this.sessionManager.emit('message', {
        type: 'pr_review_complete',
        prNumber: job.localBranchId,
        repo: `local/${job.branchName}`,
        verdict: 'error',
        summary: String(e),
      });
      return;
    }

    this.sessionManager.emit('message', {
      type: 'pr_review_complete',
      prNumber: job.localBranchId,
      repo: `local/${job.branchName}`,
      verdict: result.verdict,
      summary: result.summary,
    });

    if (result.escalate) {
      const message =
        result.escalationReason ??
        `Review for local branch ${job.branchName} was escalated per project review rules.`;
      logger.warn(`[ReviewOrchestrator] ${message}`);
      setLocalBranchPauseReason(
        job.localBranchId,
        result.baselineEscalationFloor
          ? 'baseline_escalation_floor'
          : 'review_rules_escalation',
      );
      this.sessionManager.emit('message', {
        type: 'review_escalated',
        prNumber: job.localBranchId,
        repo: `local/${job.branchName}`,
        message,
      });
      return;
    }

    if (result.verdict === 'needs_changes') {
      enqueueFeedbackItem(
        job.sessionId,
        'ai-reviewer',
        formatReviewFeedback(result, 0),
      );
    }
  }

  private onSessionEnded(sessionId: string): void {
    const session = getSession(sessionId);
    // Admits every PR-opening session type (standard, docs, ops) — a
    // needs_changes verdict re-review must fire for an ops-sourced PR the
    // same as a standard one, not just standard's own.
    if (!session || !opensPr(session.session_type ?? '')) return;

    const pr = getPRBySessionId(sessionId);
    if (!pr || !pr.review_result) return;

    let verdict: string | undefined;
    try {
      verdict = (JSON.parse(pr.review_result) as { verdict?: string }).verdict;
    } catch {
      return;
    }
    if (verdict !== 'needs_changes') return;

    const maxIter = getMaxReviewIterations();
    if (pr.review_iteration >= maxIter) return;

    // Debounce: skip if review already queued or in-flight for this PR
    // (handles the case where push_detected already enqueued a review this turn)
    const prKey = `${pr.pr_number}:${pr.repo}`;
    if (
      this.inFlightPRKeys.has(prKey) ||
      this.queue.some((j) => this.prKey(j) === prKey)
    ) {
      logger.info(
        `[ReviewOrchestrator] session_ended for session ${sessionId.slice(0, 8)}: re-review already queued/in-flight for PR #${pr.pr_number} — skipping`,
      );
      return;
    }

    logger.info(
      `[ReviewOrchestrator] session_ended for session ${sessionId.slice(0, 8)} — PR #${pr.pr_number} (${pr.repo}) has verdict needs_changes (iter ${pr.review_iteration}/${maxIter}) — triggering re-review`,
    );

    const project = getProjectByGithubRepo(pr.repo);
    this.enqueueReview({
      prNumber: pr.pr_number,
      repo: pr.repo,
      taskId: pr.task_id ?? '',
      taskUrl: session.task_url ?? '',
      contextUrl: project?.contextUrl ?? '',
    });
  }

  private consumePendingPushIfSet(prNumber: number, repo: string): void {
    const row = getPRByNumber(prNumber, repo);
    if (row?.pending_push && row.session_id) {
      setPendingPush(prNumber, repo, 0);
      logger.info(
        `[ReviewOrchestrator] pending_push detected for PR #${prNumber} — triggering re-review`,
      );
      this.sessionManager.emit('push_detected', {
        sessionId: row.session_id,
      });
    }
  }

  /**
   * A needs_changes/incomplete verdict has nowhere to route to — the PR row
   * has no session_id (e.g. a boot-swept PR that never matched a session by
   * branch, see PRBootSweep.insertIfMissing). Record the drop and surface a
   * pause reason so the PR appears on the needs-attention queue immediately
   * instead of sitting stuck with a stale verdict and no signal.
   */
  private recordVerdictRoutingFailure(
    job: ReviewJob,
    projectId: string,
    taskId: string | null | undefined,
    payload: Record<string, unknown>,
  ): void {
    logger.warn(
      `[ReviewOrchestrator] verdict routing failed for PR #${job.prNumber} (${job.repo}): no session_id to route feedback to`,
    );
    recordEvent({
      event_type: 'verdict_routing_failed',
      actor_type: 'system',
      actor_id: null,
      project_id: projectId,
      task_id: taskId ?? job.taskId ?? null,
      payload: {
        pr_number: job.prNumber,
        repo: job.repo,
        ...payload,
      },
    });
    setPauseReason(job.prNumber, job.repo, 'verdict_routing_failed');
  }

  private async executeReview(job: ReviewJob): Promise<void> {
    logger.info(
      `[ReviewOrchestrator] executeReview: entered for PR #${job.prNumber} (${job.repo}) taskId=${job.taskId ?? 'none'}`,
    );

    // Await any in-flight post-revert worktree sync before fetching the diff,
    // so the review sees the canonical file state, not the contaminated version.
    const syncKey = `${job.prNumber}:${job.repo}`;
    const pendingSync = this.pendingSyncs.get(syncKey);
    if (pendingSync) {
      logger.info(
        `[ReviewOrchestrator] executeReview: awaiting pending revert sync for PR #${job.prNumber}`,
      );
      this.pendingSyncs.delete(syncKey);
      await pendingSync;
    }

    const project = getProjectByGithubRepo(job.repo);
    if (!project) {
      logger.warn(
        `[ReviewOrchestrator] PR #${job.prNumber}: no project found for repo ${job.repo} — skipping`,
      );
      return;
    }

    // Check iteration cap before starting a review
    const prRow = getPRByNumber(job.prNumber, job.repo);
    const maxIterations = getMaxReviewIterations();
    if (prRow && prRow.review_iteration >= maxIterations) {
      const message = `Review loop for PR #${job.prNumber} reached ${maxIterations} iterations without approval. Manual intervention needed.`;
      logger.warn(`[ReviewOrchestrator] ${message}`);
      setPauseReason(job.prNumber, job.repo, 'max_reviews');
      this.sessionManager.emit('message', {
        type: 'review_escalated',
        prNumber: job.prNumber,
        repo: job.repo,
        message,
      });
      return;
    }

    // ── Pre-review pipeline (autofix → verify → analyze → tests) ────────────
    const pipelineResult = await this.preReviewPipeline.run(job, project);
    if (!pipelineResult.passed) {
      this.consumePendingPushIfSet(job.prNumber, job.repo);
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // The docs execution flow's never-auto-merged output gate: a docs PR
    // still runs the pre-review analyze gate above (secret-scan/hygiene) but
    // spawns no review session — review is source-blind and can't verify
    // doc source-fidelity against the Notion/repo source of truth, so a docs
    // PR is never gated on review_result for its (human-only) merge.
    if (prRow?.human_merge_only) {
      setPreReviewStage(job.prNumber, job.repo, null);
      logger.info(
        `[ReviewOrchestrator] PR #${job.prNumber}: human_merge_only — analyze passed, skipping review session`,
      );
      this.consumePendingPushIfSet(job.prNumber, job.repo);
      return;
    }

    setPreReviewStage(job.prNumber, job.repo, null);
    this.sessionManager.emit('message', {
      type: 'review_started',
      prNumber: job.prNumber,
      sessionId: prRow?.review_session_id ?? '',
    });

    const diffSource = this.github
      ? new GitHubDiffSource(this.github, job.repo, job.prNumber)
      : {
          fetchDiff: async () => {
            throw new Error('No GitHub client available for diff');
          },
        };

    const workItem: WorkItem = {
      type: 'pr',
      prNumber: job.prNumber,
      repo: job.repo,
    };

    let result: PRReviewResult;
    try {
      result = await this.reviewService.reviewPR(
        workItem,
        diffSource,
        project.id,
        job.contextUrl,
      );
    } catch (e) {
      if (e instanceof FetchRetryExhaustedError) {
        // review_failed was already emitted by PRReviewService; leave review_result null
        return;
      }
      // PRReviewService persists the verdict immediately after parse, before any
      // side effects. If reviewPR throws, it means parsing never completed and no
      // verdict was persisted — write the error sentinel only in that case to avoid
      // clobbering a verdict that was already successfully stored.
      const alreadyPersisted = !!getPRByNumber(job.prNumber, job.repo)
        ?.review_result;
      if (!alreadyPersisted) {
        const summary = String(e);
        setPRReviewResult(
          job.prNumber,
          job.repo,
          JSON.stringify({ verdict: 'error', summary, dimensions: [] }),
        );
        this.sessionManager.emit('message', {
          type: 'pr_review_complete',
          prNumber: job.prNumber,
          repo: job.repo,
          verdict: 'error',
          summary,
        });
      }
      return;
    }

    // Draft transition and Notion update are handled inside reviewService.reviewPR()
    // via handleApprovedVerdict. Derive draftTransitioned from the pre-review row so
    // we can include draft: false in the broadcast when applicable.
    const draftTransitioned =
      result.verdict === 'approved' && prRow?.draft === 1;

    this.sessionManager.emit('message', {
      type: 'pr_review_complete',
      prNumber: job.prNumber,
      repo: job.repo,
      verdict: result.verdict,
      summary: result.summary,
      ...(draftTransitioned && { draft: false }),
    });

    // A review_rules-driven finding routes to operator escalation instead of
    // another coding-session iteration, regardless of the raw verdict.
    if (result.escalate) {
      const message =
        result.escalationReason ??
        `Review for PR #${job.prNumber} was escalated per project review rules.`;
      logger.warn(`[ReviewOrchestrator] ${message}`);
      setPauseReason(
        job.prNumber,
        job.repo,
        result.baselineEscalationFloor
          ? 'baseline_escalation_floor'
          : 'review_rules_escalation',
      );
      this.sessionManager.emit('message', {
        type: 'review_escalated',
        prNumber: job.prNumber,
        repo: job.repo,
        message,
      });
      this.consumePendingPushIfSet(job.prNumber, job.repo);
      return;
    }

    // Route feedback to coding session via the inbox — delivered immediately if the
    // session is live-but-idle, otherwise at its next turn boundary or via respawn.
    if (result.verdict === 'needs_changes') {
      const prRow = getPRByNumber(job.prNumber, job.repo);
      if (prRow?.session_id) {
        await this.sessionManager.enqueueFeedback(
          prRow.session_id,
          'ai-reviewer',
          formatReviewFeedback(result, 0, {
            conflicted: prRow?.merge_state === 'dirty',
            baseBranch: prRow?.base_branch ?? undefined,
          }),
        );
      } else {
        this.recordVerdictRoutingFailure(job, project.id, prRow?.task_id, {
          verdict: result.verdict,
          reason: 'session_id_null',
        });
      }
    } else if (result.verdict === 'incomplete') {
      const message = `Review for PR #${job.prNumber} returned an incomplete verdict — the reviewer could not assess the PR. Manual intervention needed.`;
      logger.warn(`[ReviewOrchestrator] ${message}`);
      this.sessionManager.emit('message', {
        type: 'review_incomplete',
        prNumber: job.prNumber,
        repo: job.repo,
        message,
      });
      if (prRow?.session_id) {
        await this.sessionManager.enqueueFeedback(
          prRow.session_id,
          'ai-reviewer',
          formatReviewFeedback(result, 0, {
            conflicted: prRow?.merge_state === 'dirty',
            baseBranch: prRow?.base_branch ?? undefined,
          }),
        );
      } else {
        this.recordVerdictRoutingFailure(job, project.id, prRow?.task_id, {
          verdict: result.verdict,
          reason: 'session_id_null',
        });
      }
    } else if (result.verdict === 'approved') {
      // Depth review runs only after conformance is approved. Auto-merge is
      // held on depth_review_pending (set by PRReviewService.
      // handleApprovedVerdict, before autoMerger.attempt()) for the
      // duration of this dispatch, so a depth finding can still gate the
      // merge. Fire-and-forget from the caller's perspective — dispatch
      // itself clears the hold and re-drives the merge on every exit path;
      // the .catch() here is a last-resort guard against a throw before or
      // during the service call (e.g. getPRByNumber, diff-source
      // construction) so the hold can never strand the PR unmerged.
      this.dispatchDepthReview(job, project.id).catch((e) => {
        logger.warn(
          `[ReviewOrchestrator] depth review dispatch failed for PR #${job.prNumber} (${job.repo}) — failing open: ${e}`,
        );
        this.clearDepthReviewHoldAndRemerge(job);
      });
    }

    this.consumePendingPushIfSet(job.prNumber, job.repo);
  }

  /**
   * Dispatch the depth-review pass for a just-conformance-approved PR and
   * route its result. Session-routing is the default for a depth finding:
   * the composed finding is enqueued to the implementing session through
   * enqueueFeedback — the same path the size-only branch already uses — so
   * the PR re-enters the ordinary fix-and-re-review loop instead of stalling
   * on a human. Operator escalation (setPauseReason + review_escalated, same
   * channel the conformance pass's review_rules_escalation uses) is reserved
   * for the baseline-floor categories the design locks (CI/workflow config,
   * migrations, auth, secrets), for a PR with no linked session to route to,
   * and for a finding that has been routed MAX_DEPTH_REVIEW_ROUTE_ATTEMPTS
   * times on an unchanged head SHA without a fix landing. A floor finding on
   * a PR that does have a session both escalates AND routes — the operator
   * is informed and the session still gets the text. DepthReviewService
   * itself fails open (returns null on any error/timeout), so a null result
   * here clears the depth_review_pending hold and re-drives the merge —
   * never an escalation, never a merge block. Every exit path below clears
   * the hold except the routing and escalation paths, which keep the PR
   * paused — routing keeps depth_review_pending (holding merge on the
   * outstanding finding) rather than clearing it, and escalation replaces it
   * with depth_review_escalation.
   */
  private async dispatchDepthReview(
    job: ReviewJob,
    projectId: string,
  ): Promise<void> {
    if (!this.depthReviewService) return;

    const prRow = getPRByNumber(job.prNumber, job.repo);
    const diffSource = this.github
      ? new GitHubDiffSource(this.github, job.repo, job.prNumber)
      : {
          fetchDiff: async () => {
            throw new Error('No GitHub client available for diff');
          },
        };

    const result = await this.runDepthReviewWithCeiling(
      job,
      projectId,
      diffSource,
      prRow?.task_id ?? null,
    );
    if (!result) {
      this.clearDepthReviewHoldAndRemerge(job);
      return;
    }

    const headSha = prRow?.head_sha ?? null;
    const priorVerdict = getDepthReviewVerdict(job.prNumber, job.repo);
    const priorRouteCount =
      priorVerdict?.head_sha && priorVerdict.head_sha === headSha
        ? (priorVerdict.route_count ?? 0)
        : 0;
    const routeCount = result.hasNonSizeFailure ? priorRouteCount + 1 : 0;

    // Persist the verdict and record its audit event — a storage failure
    // here must not block the merge path (same fail-open shape as dispatch
    // itself), so it's isolated in its own try/catch rather than allowed to
    // throw into the escalate/auto-fix/clear-hold branches below.
    try {
      upsertDepthReviewVerdict({
        pr_number: job.prNumber,
        repo: job.repo,
        head_sha: headSha,
        verdict: result.verdict,
        dimensions: JSON.stringify(result.dimensions),
        summary: result.summary,
        depth_session_id: result.sessionId,
        route_count: routeCount,
      });
      recordEvent({
        event_type: 'depth_review_completed',
        actor_type: 'system',
        task_id: prRow?.task_id ?? null,
        payload: {
          pr_number: job.prNumber,
          repo: job.repo,
          verdict: result.verdict,
          hasNonSizeFailure: result.hasNonSizeFailure,
          sizeOnlyFailure: result.sizeOnlyFailure,
        },
      });
    } catch (e) {
      logger.warn(
        `[ReviewOrchestrator] failed to persist depth review verdict for PR #${job.prNumber} (${job.repo}) — failing open: ${e}`,
      );
    }

    if (result.hasNonSizeFailure) {
      const failing = result.dimensions.filter(
        (d) => !d.passed && d.name !== DEPTH_SIZE_DIMENSION_NAME,
      );
      const message = [
        `Depth review for PR #${job.prNumber} found a defect beyond spec-conformance:`,
        result.summary,
        '',
        ...failing.map((d) => `- **${d.name}**: ${d.notes}`),
      ].join('\n');
      logger.warn(`[ReviewOrchestrator] ${message}`);

      let floorMatches: BaselineEscalationMatch[] = [];
      try {
        const diffText = await diffSource.fetchDiff();
        floorMatches = matchBaselineEscalationFloor(parseDiffFiles(diffText));
      } catch (e) {
        logger.warn(
          `[ReviewOrchestrator] failed to re-fetch diff for PR #${job.prNumber} (${job.repo}) to check the baseline escalation floor — treating as no floor match: ${e}`,
        );
      }
      const boundExceeded = routeCount > MAX_DEPTH_REVIEW_ROUTE_ATTEMPTS;
      const noSession = !prRow?.session_id;
      const mustEscalate =
        floorMatches.length > 0 || boundExceeded || noSession;

      if (mustEscalate) {
        const detailParts: string[] = [];
        if (floorMatches.length > 0) {
          const categories = [...new Set(floorMatches.map((m) => m.category))];
          detailParts.push(`baseline floor: ${categories.join(', ')}`);
        }
        if (boundExceeded) {
          detailParts.push(
            `re-routed ${routeCount} times on unchanged head SHA without a fix`,
          );
        }
        if (noSession) {
          detailParts.push('no linked session — routing was impossible');
        }
        // Replaces the depth_review_pending hold — the PR stays paused, now
        // on an escalation reason, not merged.
        setPauseReason(
          job.prNumber,
          job.repo,
          'depth_review_escalation',
          detailParts.join('; '),
        );
        this.sessionManager.emit('message', {
          type: 'review_escalated',
          prNumber: job.prNumber,
          repo: job.repo,
          message,
        });
      }

      // Session-routing is the default whenever a session is linked — even
      // when the finding also escalated (floor / bound), so the session
      // isn't left waiting on an operator with no feedback at all.
      if (prRow?.session_id) {
        await this.sessionManager.enqueueFeedback(
          prRow.session_id,
          'ai-reviewer',
          message,
        );
      }

      // Both exit paths leave the PR paused: escalation is on
      // depth_review_escalation (set above); a plain route keeps the
      // depth_review_pending hold already in place — do not clear it or
      // re-drive the merge, or an unfixed defect could merge before the
      // session's next push re-triggers conformance + depth review.
      return;
    }

    if (result.sizeOnlyFailure && prRow?.session_id) {
      const sizeDim = result.dimensions.find(
        (d) => d.name === DEPTH_SIZE_DIMENSION_NAME && !d.passed,
      );
      const message = [
        `The depth review pass flagged this PR for scope creep (size-proportionality):`,
        sizeDim?.notes ?? result.summary,
      ].join('\n');
      await this.sessionManager.enqueueFeedback(
        prRow.session_id,
        'ai-reviewer',
        message,
      );
    }
    this.clearDepthReviewHoldAndRemerge(job);
  }

  /**
   * Races the depth-review service call against a backstop ceiling well
   * above DepthReviewService's own internal timeout (15 min), so a session
   * that never reaches a terminal status there (see the depth_review
   * terminal-status fixes this mirrors) still cannot hold a merge
   * indefinitely. DepthReviewService.runDepthReview() itself never rejects
   * (it fails open to null internally) — this is a second, independent
   * backstop, not a replacement for that contract.
   */
  private runDepthReviewWithCeiling(
    job: ReviewJob,
    projectId: string,
    diffSource: DiffSource,
    taskId: string | null,
  ): Promise<DepthReviewResult | null> {
    return new Promise((resolve) => {
      let settled = false;
      const ceiling = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn(
          `[ReviewOrchestrator] depth review for PR #${job.prNumber} (${job.repo}) exceeded the ${Math.round(DEPTH_REVIEW_DISPATCH_CEILING_MS / 60000)}-minute dispatch ceiling — failing open`,
        );
        resolve(null);
      }, DEPTH_REVIEW_DISPATCH_CEILING_MS);

      this.depthReviewService!.runDepthReview(
        job.prNumber,
        job.repo,
        diffSource,
        projectId,
        job.contextUrl,
        taskId,
      ).then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(ceiling);
          resolve(result);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(ceiling);
          resolve(null);
        },
      );
    });
  }

  /**
   * Clears the depth_review_pending hold and re-attempts the merge — used
   * on every dispatchDepthReview exit path that doesn't escalate. Only
   * clears when the current pause_reason is still depth_review_pending, so
   * an unrelated hold set in the meantime (e.g. manual_verification_pending,
   * review_rules_escalation) is never clobbered — attempt() is still called
   * either way since AutoMerger re-checks pause_reason itself and no-ops if
   * one remains.
   */
  private clearDepthReviewHoldAndRemerge(job: ReviewJob): void {
    const row = getPRByNumber(job.prNumber, job.repo);
    if (
      parsePauseReason(row?.pause_reason ?? null)?.reason ===
      'depth_review_pending'
    ) {
      setPauseReason(job.prNumber, job.repo, null);
    }
    if (this.autoMerger) {
      this.autoMerger.attempt(job.prNumber, job.repo);
    }
  }
}
