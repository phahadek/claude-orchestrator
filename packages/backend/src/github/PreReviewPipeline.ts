import { logger } from '../logger';
import {
  getPRByNumber,
  getSession,
  setPRReviewResult,
  setLastReviewedSha,
  setPreReviewStage,
  setPauseReason,
  getLatestTestRequestRun,
  deleteTestRequestRunsForContentHash,
  hasAnalyzeResultForSha,
  upsertAnalyzeResult,
  getAnalyzeResult,
  deleteAnalyzeResult,
  getAnalyzeContentCacheResult,
  insertAnalyzeContentCacheResult,
  addAutofixSha,
  getTestRequestRunById,
  updateTestRequestRunState,
} from '../db/queries';
import {
  filterBaseAttributableFailuresForF2Gate,
  renderBaseAttributableFilterDigest,
} from '../orchestration/baseAttributableFilter';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import {
  loadAutofixCommands,
  runAutofix,
  getChangedFiles,
} from '../session/autofix-runner';
import {
  normalizeAnalyzeCommand,
  isAnalyzeCommandTriggered,
  computeTriggerContentHash,
  computeWholeTreeContentHash,
  matchesTransientOutputPattern,
} from '../session/analyzeGating';
import { validateAndRepairGitConfig } from '../orchestration/gitConfigIntegrity';
import { runVerifyAsGate } from '../orchestration/verifyRunner';
import { runTestCommands } from '../session/test-runner';
import { runProjectTestRequest } from '../orchestration/testRequestLane';
import type { TestRequestRunResult } from '../orchestration/testRequestLane';
import { runFilePollutionCheck } from '../session/filePollutionCheck';
import { formatCIFailureFeedback } from './reviewUtils';
import { recordEvent } from '../audit/AuditLog';
import type { SessionManager } from '../session/SessionManager';
import type { GitHubClient } from './GitHubClient';
import type { ReviewJob, FlakeRecoveryOutcome } from './types';
import type { ProjectConfig } from '../config';
import type { PauseReason } from '../db/types';
import { parsePauseReason } from '../db/pauseReason';

interface GateFailureDetail {
  failedCommand?: string;
  truncatedOutput?: string;
  summary: string;
  output?: string;
  isGitInfraFailure?: boolean;
  isToolInfraFailure?: boolean;
  toolFailureReason?: string;
}

interface GateStageDescriptor {
  id: string;
  mode: 'gate';
  runningStage: string;
  skipIf: (ctx: StageContext) => boolean;
  run: (ctx: StageContext) => Promise<GateFailureDetail | null>;
  blockedStage: string;
  verdict: string;
  pauseReason?: PauseReason;
  formatFailure: (
    detail: GateFailureDetail,
    prConflictCtx: { conflicted: boolean; baseBranch: string },
  ) => string;
}

interface RecordStageDescriptor {
  id: string;
  mode: 'record';
  runningStage: string;
  skipIf: (ctx: StageContext) => boolean;
  run: (ctx: StageContext) => Promise<void>;
}

type StageDescriptor = GateStageDescriptor | RecordStageDescriptor;

interface StageContext {
  prNumber: number;
  repo: string;
  headSha: string;
  worktreePath: string;
  project: ProjectConfig;
  job: ReviewJob;
}

export class PreReviewPipeline {
  private readonly stages: StageDescriptor[];

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly github?: GitHubClient,
  ) {
    this.stages = this.buildStages();
  }

  private buildStages(): StageDescriptor[] {
    return [
      this.buildAutofixStage(),
      this.buildVerifyStage(),
      this.buildAnalyzeStage(),
      this.buildTestsStage(),
    ];
  }

  private buildAutofixStage(): GateStageDescriptor {
    return {
      id: 'autofix',
      mode: 'gate',
      runningStage: 'autofix',
      skipIf: (ctx) => {
        const cmds = loadAutofixCommands(ctx.project.projectDir);
        return cmds.length === 0;
      },
      run: async (ctx) => {
        const cmds = loadAutofixCommands(ctx.project.projectDir);
        if (cmds.length === 0) return null;

        this.sessionManager.emit('message', {
          type: 'autofix_started',
          prNumber: ctx.prNumber,
          repo: ctx.repo,
        });
        recordEvent({
          event_type: 'autofix_started',
          actor_type: 'system',
          project_id: ctx.project.id,
          task_id: ctx.job.taskId ?? null,
          payload: { prNumber: ctx.prNumber, repo: ctx.repo },
        });

        let success = true;
        let summary = 'no worktree available — autofix skipped';

        if (ctx.worktreePath) {
          const autofixCfg = loadOrchestratorConfig(ctx.project.projectDir);
          try {
            const result = await runAutofix(
              ctx.worktreePath,
              ctx.project.projectDir,
              cmds,
              (msg) =>
                logger.info(
                  `[PreReviewPipeline] autofix PR #${ctx.prNumber}: ${msg}`,
                ),
              'dev',
              autofixCfg.autofix_skip_ci,
            );

            if (result.isGitInfraFailure) {
              try {
                await validateAndRepairGitConfig(
                  ctx.project.projectDir,
                  ctx.project.id,
                );
              } catch (err) {
                logger.warn(
                  `[PreReviewPipeline] git config repair failed for PR #${ctx.prNumber}: ${err}`,
                );
              }
              return { summary: result.summary, isGitInfraFailure: true };
            }

            if (result.isToolInfraFailure) {
              return {
                summary: result.summary,
                isToolInfraFailure: true,
                toolFailureReason: result.toolFailureReason,
              };
            }

            success = result.success;
            summary = result.summary;

            // When autofix commands exit 1 and leave violations they could not
            // fix automatically (e.g. ruff E501), route a nudge to the
            // implementing session so the coding agent can address them.
            // The gate still passes — the commit captured all auto-fixable
            // changes; the remaining violations are the agent's responsibility.
            if (result.unfixableViolations) {
              const prRow = getPRByNumber(ctx.prNumber, ctx.repo);
              const sessionId = prRow?.session_id;
              if (sessionId) {
                const nudge =
                  `## Autofix Found Unfixable Violations\n\n` +
                  `The autofix pass committed what it could, but some violations ` +
                  `could not be fixed automatically (e.g. line-length E501). ` +
                  `Please fix these manually and re-push.\n\n` +
                  `**Violations:**\n\`\`\`\n${result.unfixableViolations}\n\`\`\``;
                try {
                  await this.sessionManager.sendOrResume(sessionId, nudge);
                } catch (e) {
                  logger.warn(
                    `[PreReviewPipeline] unfixable-violation nudge failed for PR #${ctx.prNumber}: ${e}`,
                  );
                }
              }
            }

            if (result.commitSha) {
              addAutofixSha(ctx.prNumber, ctx.repo, result.commitSha);
              const prRow = getPRByNumber(ctx.prNumber, ctx.repo);
              if (prRow?.session_id && result.touchedFiles?.length) {
                this.sessionManager.addToRevertLock(
                  prRow.session_id,
                  result.touchedFiles,
                );
              }
              if (this.github) {
                const pollutionResult = await runFilePollutionCheck({
                  github: this.github,
                  worktreePath: ctx.worktreePath,
                  repo: ctx.repo,
                  prNumber: ctx.prNumber,
                  baseBranch:
                    getPRByNumber(ctx.prNumber, ctx.repo)?.base_branch ?? 'dev',
                  sessionId:
                    getPRByNumber(ctx.prNumber, ctx.repo)?.session_id ?? null,
                  projectId: ctx.project.id,
                  taskId: ctx.job.taskId,
                  skipCi: autofixCfg.autofix_skip_ci,
                  onReverted: (files) => {
                    const row = getPRByNumber(ctx.prNumber, ctx.repo);
                    if (row?.session_id) {
                      this.sessionManager.addToRevertLock(
                        row.session_id,
                        files,
                      );
                    }
                  },
                });
                if (pollutionResult.revertCommitSha) {
                  addAutofixSha(
                    ctx.prNumber,
                    ctx.repo,
                    pollutionResult.revertCommitSha,
                  );
                }
              }
            }
          } catch (err) {
            success = false;
            summary = `autofix threw: ${String(err)}`;
            logger.error(
              `[PreReviewPipeline] autofix error for PR #${ctx.prNumber}:`,
              err,
            );
          }
        }

        this.sessionManager.emit('message', {
          type: 'autofix_complete',
          prNumber: ctx.prNumber,
          repo: ctx.repo,
          success,
          summary,
        });
        recordEvent({
          event_type: 'autofix_complete',
          actor_type: 'system',
          project_id: ctx.project.id,
          task_id: ctx.job.taskId ?? null,
          payload: { prNumber: ctx.prNumber, repo: ctx.repo, success, summary },
        });

        if (!success) {
          return { summary };
        }
        return null;
      },
      blockedStage: 'blocked_autofix',
      verdict: 'autofix_failed',
      formatFailure: (detail) =>
        `## Autofix Gate Failure\n\nThe autofix pipeline failed and could not produce a clean commit.\n\n**Error:** ${detail.summary}\n\nPlease fix the issue and re-push.`,
    };
  }

  private buildVerifyStage(): GateStageDescriptor {
    return {
      id: 'verify',
      mode: 'gate',
      runningStage: 'verify',
      skipIf: (ctx) => !ctx.worktreePath,
      run: async (ctx) => {
        const config = loadOrchestratorConfig(ctx.project.projectDir);
        const result = await runVerifyAsGate(ctx.worktreePath, config.verify);
        if (!result.passed) {
          return {
            failedCommand: result.failedCommand,
            truncatedOutput: result.truncatedOutput,
            summary: result.failedCommand
              ? `verify failed: ${result.failedCommand}`
              : 'verify failed',
          };
        }
        return null;
      },
      blockedStage: 'blocked_verify',
      verdict: 'verify_failed',
      formatFailure: (detail, { conflicted, baseBranch }) =>
        formatCIFailureFeedback({
          source: 'verify',
          failedCommand: detail.failedCommand,
          truncatedOutput: detail.truncatedOutput,
          conflicted,
          baseBranch,
        }),
    };
  }

  private buildAnalyzeStage(): GateStageDescriptor {
    return {
      id: 'analyze',
      mode: 'gate',
      runningStage: 'analyzing',
      skipIf: (ctx) => {
        if (!ctx.headSha || !ctx.worktreePath) return true;
        const config = loadOrchestratorConfig(ctx.project.projectDir);
        return !config.analyze?.length;
      },
      run: async (ctx) => {
        const config = loadOrchestratorConfig(ctx.project.projectDir);
        if (!config.analyze?.length) return null;

        let passed: boolean;
        let output: string;

        if (hasAnalyzeResultForSha(ctx.prNumber, ctx.repo, ctx.headSha)) {
          logger.info(
            `[PreReviewPipeline] analyze already ran for PR #${ctx.prNumber} SHA ${ctx.headSha.slice(0, 7)} — returning cached result`,
          );
          const cached = getAnalyzeResult(ctx.prNumber, ctx.repo, ctx.headSha);
          passed = cached?.passed === 1;
          output = cached?.output ?? '';
        } else {
          const normalized = config.analyze.map(normalizeAnalyzeCommand);
          const diffPaths = await getChangedFiles(
            ctx.worktreePath,
            ctx.project.baseBranch,
          );

          const outputParts: string[] = [];
          let allPassed = true;
          let anyTimedOut = false;
          let anyOomKilled = false;
          let anyTransientOutputMatch = false;

          for (const entry of normalized) {
            if (!isAnalyzeCommandTriggered(entry, diffPaths)) {
              logger.info(
                `[PreReviewPipeline] analyze skipped (no trigger-path match) PR #${ctx.prNumber}: ${entry.command}`,
              );
              outputParts.push(
                `$ ${entry.command}\n[skipped — no diff file matched trigger_paths]`,
              );
              continue;
            }

            const contentHash = entry.trigger_paths?.length
              ? await computeTriggerContentHash(
                  ctx.worktreePath,
                  entry.trigger_paths,
                )
              : null;

            if (contentHash) {
              const cached = getAnalyzeContentCacheResult(
                entry.command,
                contentHash,
              );
              if (cached) {
                logger.info(
                  `[PreReviewPipeline] analyze content-cache hit PR #${ctx.prNumber}: ${entry.command}`,
                );
                outputParts.push(
                  `$ ${entry.command}\n[cached]\n${cached.output}`,
                );
                if (cached.passed !== 1) allPassed = false;
                if (!allPassed && config.analyze_fail_fast) break;
                continue;
              }
            }

            const result = await runTestCommands(
              ctx.worktreePath,
              [entry.command],
              config.analyze_timeout_sec,
              (msg) =>
                logger.info(
                  `[PreReviewPipeline] analyze PR #${ctx.prNumber}: ${msg}`,
                ),
              {
                maxRssMb: config.analyze_max_rss_mb,
                failFast: config.analyze_fail_fast,
              },
            );

            outputParts.push(result.output);
            if (!result.passed) allPassed = false;
            if (result.timedOut) anyTimedOut = true;
            if (result.oomKilled) anyOomKilled = true;
            if (
              !result.passed &&
              matchesTransientOutputPattern(entry, result.output)
            ) {
              anyTransientOutputMatch = true;
            }

            if (contentHash) {
              insertAnalyzeContentCacheResult(
                entry.command,
                contentHash,
                result.passed,
                result.output,
              );
            }

            if (!allPassed && config.analyze_fail_fast) break;
          }

          passed = allPassed;
          output = outputParts.join('\n');
          upsertAnalyzeResult(
            ctx.prNumber,
            ctx.repo,
            ctx.headSha,
            passed,
            output,
            anyTimedOut || anyOomKilled || anyTransientOutputMatch,
          );
        }

        logger.info(
          `[PreReviewPipeline] analyze ${passed ? 'PASSED' : 'FAILED'} for PR #${ctx.prNumber} SHA ${ctx.headSha.slice(0, 7)}`,
        );

        if (!passed) {
          return {
            summary: 'analyze gate failed',
            output,
          };
        }

        return null;
      },
      blockedStage: 'blocked_analyze',
      verdict: 'analyze_failed',
      pauseReason: 'analyze_failing',
      formatFailure: (detail) =>
        `## Analyze Gate Failure\n\nThe static analysis gate failed. Please fix the issues below and re-push.\n\n\`\`\`\n${detail.output ?? detail.summary}\n\`\`\``,
    };
  }

  private buildTestsStage(): RecordStageDescriptor {
    return {
      id: 'tests',
      mode: 'record',
      runningStage: 'tests',
      skipIf: (ctx) => {
        if (!ctx.headSha || !ctx.worktreePath) return true;
        const config = loadOrchestratorConfig(ctx.project.projectDir);
        return !config.test?.length;
      },
      run: async (ctx) => {
        const config = loadOrchestratorConfig(ctx.project.projectDir);
        if (!config.test?.length) return;

        const contentHash = await computeWholeTreeContentHash(ctx.worktreePath);
        if (
          contentHash &&
          getLatestTestRequestRun(ctx.project.id, contentHash)
        ) {
          logger.info(
            `[PreReviewPipeline] tests content-cache hit PR #${ctx.prNumber} SHA ${ctx.headSha.slice(0, 7)} — skipping`,
          );
          return;
        }

        const result = contentHash
          ? await runProjectTestRequest({
              projectId: ctx.project.id,
              contentHash,
              worktreePath: ctx.worktreePath,
              commands: config.test,
              timeoutSec: config.test_timeout_sec,
              maxRssMb: config.test_max_rss_mb,
              sessionId: null,
              runOrigin: 'pr_pipeline',
            })
          : await runTestCommands(
              ctx.worktreePath,
              config.test,
              config.test_timeout_sec,
              (msg) =>
                logger.info(
                  `[PreReviewPipeline] test PR #${ctx.prNumber}: ${msg}`,
                ),
              {
                maxRssMb: config.test_max_rss_mb,
                failFast: config.test_fail_fast,
              },
            );

        logger.info(
          `[PreReviewPipeline] tests ${result.passed ? 'PASSED' : 'FAILED'} for PR #${ctx.prNumber} SHA ${ctx.headSha.slice(0, 7)}`,
        );

        if (contentHash && !result.passed) {
          await this.applyBaseAttributableF2GateFilter(
            ctx,
            (result as TestRequestRunResult).runId,
          );
        }
      },
    };
  }

  /**
   * Base-health-aware f2-gate pre-empt, applied as soon as PreReviewPipeline
   * itself records a failing F2 run — before PRMergeWatcher's own poll would
   * otherwise pause the PR and nudge the session. Reuses the same
   * filterBaseAttributableFailures the test.request lane calls
   * (stagedIntents.ts), gated by the two f2-gate masking guards
   * (filterBaseAttributableFailuresForF2Gate), with `changedFiles` sourced
   * from this stage's own live session worktree (getChangedFiles) since a
   * worktree is available here, unlike PRMergeWatcher's merge-time check.
   * A fully-excused run has its test_request_runs row flipped to 'passed' —
   * the same state flip stagedIntents.ts's test.request lane applies on
   * filtered_pass — so PRMergeWatcher's own gate read never re-blocks on it,
   * and an advisory (non-blocking) pause pill is set so the exclusion stays
   * visible to an operator rather than passing silently. A partially-excused
   * run leaves the row 'failed' (PRMergeWatcher's own gate re-derives the
   * narrower remainder) but still surfaces the digest via the same pill.
   */
  private async applyBaseAttributableF2GateFilter(
    ctx: StageContext,
    runId: string,
  ): Promise<void> {
    const run = getTestRequestRunById(runId);
    if (!run) return;

    let changedFiles: string[];
    try {
      changedFiles = await getChangedFiles(
        ctx.worktreePath,
        getPRByNumber(ctx.prNumber, ctx.repo)?.base_branch ??
          ctx.project.baseBranch,
      );
    } catch (err) {
      logger.warn(
        `[PreReviewPipeline] PR #${ctx.prNumber}: getChangedFiles failed for f2 gate masking guard: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    let gate: Awaited<
      ReturnType<typeof filterBaseAttributableFailuresForF2Gate>
    >;
    try {
      gate = await filterBaseAttributableFailuresForF2Gate(
        ctx.project,
        run,
        changedFiles,
        ctx.job.taskId ?? null,
      );
    } catch (err) {
      logger.warn(
        `[PreReviewPipeline] PR #${ctx.prNumber}: base-attributable f2 gate filter failed: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    if (gate.result.outcome === 'unfiltered') return;

    const digest = renderBaseAttributableFilterDigest(
      gate.result,
      gate.guardBlocked,
    );
    setPauseReason(
      ctx.prNumber,
      ctx.repo,
      'base_attributable_test_excluded',
      digest.slice(0, 1000),
    );
    if (gate.result.passed) {
      updateTestRequestRunState(runId, 'passed');
    }
  }

  /**
   * Actuate a session's verified-flaky disposition on the F2 (orchestrator-run
   * test) gate: audit + invalidate the shared content-hash cache entry
   * (test_request_runs, keyed by (project_id, content_hash)), then re-run the
   * same test commands against the same SHA — no new commit, no new SHA.
   * Returns null when the project has no F2 tests configured.
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
    const config = loadOrchestratorConfig(project.projectDir);
    if (!config.test?.length) return null;

    const contentHash = await computeWholeTreeContentHash(worktreePath);

    recordEvent({
      event_type: 'flake_recovery_f2_invalidated',
      actor_type: 'system',
      project_id: project.id,
      task_id: null,
      payload: { prNumber, repo, sha: headSha },
    });
    if (contentHash) {
      deleteTestRequestRunsForContentHash(project.id, contentHash);
    }

    const { passed, output } = contentHash
      ? await runProjectTestRequest({
          projectId: project.id,
          contentHash,
          worktreePath,
          commands: config.test,
          timeoutSec: config.test_timeout_sec,
          maxRssMb: config.test_max_rss_mb,
          sessionId: null,
          runOrigin: 'pr_pipeline',
        })
      : await runTestCommands(
          worktreePath,
          config.test,
          config.test_timeout_sec,
          (msg) =>
            logger.info(
              `[PreReviewPipeline] flaky-rerun PR #${prNumber}: ${msg}`,
            ),
          { maxRssMb: config.test_max_rss_mb, failFast: config.test_fail_fast },
        );

    // Re-verify head_sha immediately before recording the outcome — a push
    // that landed mid-run means this result no longer speaks to the SHA the
    // disposition was diagnosed against.
    let outcome: FlakeRecoveryOutcome = passed ? 'passed' : 'failed';
    if (this.github) {
      const current = await this.github.getPRState(prNumber, repo);
      if (current.headSha !== headSha) {
        outcome = 'inconclusive';
      }
    }

    recordEvent({
      event_type: 'flake_recovery_f2_rerun',
      actor_type: 'system',
      project_id: project.id,
      task_id: null,
      payload: { prNumber, repo, sha: headSha, outcome },
    });
    logger.info(
      `[PreReviewPipeline] flaky re-run ${outcome} for PR #${prNumber} SHA ${headSha.slice(0, 7)}`,
    );
    return { outcome, passed, output };
  }

  /**
   * Actuate a session's verified-flaky disposition on the analyze gate:
   * audit + invalidate the permanent per-(pr,repo,sha) analyze result row,
   * then re-run the same analyze commands (respecting trigger_paths, not the
   * content-hash cache — this is an explicit re-run, not a fresh evaluation)
   * against the same SHA — no new commit, no new SHA, and no full-pipeline
   * retry. Returns null when the project has no analyze commands configured.
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
    const config = loadOrchestratorConfig(project.projectDir);
    if (!config.analyze?.length) return null;

    recordEvent({
      event_type: 'flake_recovery_analyze_invalidated',
      actor_type: 'system',
      project_id: project.id,
      task_id: null,
      payload: { prNumber, repo, sha: headSha },
    });
    deleteAnalyzeResult(prNumber, repo, headSha);

    const normalized = config.analyze.map(normalizeAnalyzeCommand);
    const diffPaths = await getChangedFiles(worktreePath, project.baseBranch);

    const outputParts: string[] = [];
    let allPassed = true;
    let anyTimedOut = false;
    let anyOomKilled = false;
    let anyTransientOutputMatch = false;

    for (const entry of normalized) {
      if (!isAnalyzeCommandTriggered(entry, diffPaths)) {
        outputParts.push(
          `$ ${entry.command}\n[skipped — no diff file matched trigger_paths]`,
        );
        continue;
      }

      const result = await runTestCommands(
        worktreePath,
        [entry.command],
        config.analyze_timeout_sec,
        (msg) =>
          logger.info(
            `[PreReviewPipeline] flaky-rerun analyze PR #${prNumber}: ${msg}`,
          ),
        {
          maxRssMb: config.analyze_max_rss_mb,
          failFast: config.analyze_fail_fast,
        },
      );

      outputParts.push(result.output);
      if (!result.passed) allPassed = false;
      if (result.timedOut) anyTimedOut = true;
      if (result.oomKilled) anyOomKilled = true;
      if (
        !result.passed &&
        matchesTransientOutputPattern(entry, result.output)
      ) {
        anyTransientOutputMatch = true;
      }

      if (!allPassed && config.analyze_fail_fast) break;
    }

    const passed = allPassed;
    const output = outputParts.join('\n');
    upsertAnalyzeResult(
      prNumber,
      repo,
      headSha,
      passed,
      output,
      anyTimedOut || anyOomKilled || anyTransientOutputMatch,
    );

    // Re-verify head_sha immediately before recording the outcome — a push
    // that landed mid-run means this result no longer speaks to the SHA the
    // disposition was diagnosed against.
    let outcome: FlakeRecoveryOutcome = passed ? 'passed' : 'failed';
    if (this.github) {
      const current = await this.github.getPRState(prNumber, repo);
      if (current.headSha !== headSha) {
        outcome = 'inconclusive';
      }
    }

    recordEvent({
      event_type: 'flake_recovery_analyze_rerun',
      actor_type: 'system',
      project_id: project.id,
      task_id: null,
      payload: { prNumber, repo, sha: headSha, outcome },
    });
    logger.info(
      `[PreReviewPipeline] flaky analyze re-run ${outcome} for PR #${prNumber} SHA ${headSha.slice(0, 7)}`,
    );
    return { outcome, passed, output };
  }

  /**
   * Gate failure handler:
   * 1. setPRReviewResult(verdict)
   * 2. setLastReviewedSha
   * 3. setPreReviewStage('blocked_<gate>')
   * 4. (optional) setPauseReason + sendOrResume(formatFailure)
   */
  private async handleGateFailure(
    stage: GateStageDescriptor,
    job: ReviewJob,
    detail: GateFailureDetail,
  ): Promise<void> {
    const prRow = getPRByNumber(job.prNumber, job.repo);

    const verdict = detail.isGitInfraFailure
      ? 'autofix_git_infra_failure'
      : detail.isToolInfraFailure
        ? 'autofix_tool_infra_failure'
        : stage.verdict;

    setPRReviewResult(
      job.prNumber,
      job.repo,
      JSON.stringify({
        verdict,
        summary: detail.summary,
        dimensions: [],
      }),
    );

    setLastReviewedSha(job.prNumber, job.repo, prRow?.head_sha ?? null);

    setPreReviewStage(job.prNumber, job.repo, stage.blockedStage);

    const pauseReasonToSet: PauseReason | undefined = detail.isGitInfraFailure
      ? 'autofix_git_infra_failure'
      : detail.isToolInfraFailure
        ? 'autofix_tool_infra_failure'
        : stage.pauseReason;
    if (pauseReasonToSet) {
      setPauseReason(job.prNumber, job.repo, pauseReasonToSet);
    }

    // A tool-infra failure is a host/environment issue the session cannot
    // fix by pushing code — route it to the operator instead of nudging.
    if (detail.isToolInfraFailure) return;

    const sessionId = prRow?.session_id;
    if (!sessionId) return;

    const message = detail.isGitInfraFailure
      ? `## Autofix Infrastructure Failure\n\nA git operation failed with exit code 128, indicating a git infrastructure issue (likely a corrupted .git/config). The orchestrator has attempted to repair the configuration automatically.\n\n**Detail:** ${detail.summary}`
      : stage.formatFailure(detail, {
          conflicted: prRow?.merge_state === 'dirty',
          baseBranch: prRow?.base_branch ?? 'dev',
        });
    try {
      await this.sessionManager.sendOrResume(sessionId, message);
    } catch (e) {
      logger.warn(
        `[PreReviewPipeline] gate failure routing failed for PR #${job.prNumber} stage=${stage.id}: ${e}`,
      );
    }
  }

  private emitAuditStageEvent(
    eventType:
      | 'pipeline_stage_entered'
      | 'pipeline_stage_passed'
      | 'pipeline_stage_failed',
    job: ReviewJob,
    project: ProjectConfig,
    stage: string,
    extra?: { summary?: string; failedCommand?: string },
  ): void {
    recordEvent({
      event_type: eventType,
      actor_type: 'system',
      project_id: project.id,
      task_id: job.taskId ?? null,
      payload: {
        prNumber: job.prNumber,
        repo: job.repo,
        stage,
        ...extra,
      },
    });
  }

  async run(
    job: ReviewJob,
    project: ProjectConfig,
  ): Promise<{ passed: boolean }> {
    const prRow = getPRByNumber(job.prNumber, job.repo);
    const headSha = prRow?.head_sha ?? '';
    const worktreePath = prRow?.session_id
      ? (getSession(prRow.session_id)?.worktree_path ?? '')
      : '';

    const ctx: StageContext = {
      prNumber: job.prNumber,
      repo: job.repo,
      headSha,
      worktreePath,
      project,
      job,
    };

    for (const stage of this.stages) {
      if (stage.skipIf(ctx)) {
        logger.info(
          `[PreReviewPipeline] PR #${job.prNumber}: stage=${stage.id} skipped`,
        );
        continue;
      }

      logger.info(
        `[PreReviewPipeline] PR #${job.prNumber}: stage=${stage.id} entered`,
      );
      setPreReviewStage(job.prNumber, job.repo, stage.runningStage);
      this.sessionManager.emit('message', {
        type: 'pipeline_stage_entered',
        prNumber: job.prNumber,
        repo: job.repo,
        stage: stage.id,
      });
      this.emitAuditStageEvent(
        'pipeline_stage_entered',
        job,
        project,
        stage.id,
      );

      if (stage.mode === 'gate') {
        const failure = await stage.run(ctx);
        if (failure !== null) {
          logger.info(
            `[PreReviewPipeline] PR #${job.prNumber}: gate stage=${stage.id} FAILED`,
          );
          this.sessionManager.emit('message', {
            type: 'pipeline_stage_failed',
            prNumber: job.prNumber,
            repo: job.repo,
            stage: stage.id,
            summary: failure.summary,
            failedCommand: failure.failedCommand,
          });
          this.emitAuditStageEvent(
            'pipeline_stage_failed',
            job,
            project,
            stage.id,
            {
              summary: failure.summary,
              failedCommand: failure.failedCommand,
            },
          );
          await this.handleGateFailure(stage, job, failure);
          return { passed: false };
        }
        logger.info(
          `[PreReviewPipeline] PR #${job.prNumber}: gate stage=${stage.id} passed`,
        );
        this.sessionManager.emit('message', {
          type: 'pipeline_stage_passed',
          prNumber: job.prNumber,
          repo: job.repo,
          stage: stage.id,
        });
        this.emitAuditStageEvent(
          'pipeline_stage_passed',
          job,
          project,
          stage.id,
        );
      } else {
        await stage.run(ctx);
        logger.info(
          `[PreReviewPipeline] PR #${job.prNumber}: record stage=${stage.id} complete`,
        );
        this.sessionManager.emit('message', {
          type: 'pipeline_stage_passed',
          prNumber: job.prNumber,
          repo: job.repo,
          stage: stage.id,
        });
        this.emitAuditStageEvent(
          'pipeline_stage_passed',
          job,
          project,
          stage.id,
        );
      }
    }

    setPreReviewStage(job.prNumber, job.repo, 'awaiting_review');
    this.clearStalePauseOnSuccess(job);
    return { passed: true };
  }

  /**
   * Pauses this pipeline itself sets on gate failure: every stage descriptor's
   * pauseReason, plus 'autofix_git_infra_failure' and 'autofix_tool_infra_failure'
   * which handleGateFailure sets imperatively (outside the stage array) on
   * infra failures.
   */
  private gateOwnedPauseReasons(): Set<PauseReason> {
    const owned = new Set<PauseReason>([
      'autofix_git_infra_failure',
      'autofix_tool_infra_failure',
    ]);
    for (const stage of this.stages) {
      if (stage.mode === 'gate' && stage.pauseReason) {
        owned.add(stage.pauseReason);
      }
    }
    return owned;
  }

  private clearStalePauseOnSuccess(job: ReviewJob): void {
    const prRow = getPRByNumber(job.prNumber, job.repo);
    const pauseStruct = parsePauseReason(prRow?.pause_reason ?? null);
    if (!pauseStruct || !this.gateOwnedPauseReasons().has(pauseStruct.reason)) {
      return;
    }
    setPauseReason(job.prNumber, job.repo, null);
    logger.info(
      `[PreReviewPipeline] PR #${job.prNumber}: cleared stale pause_reason=${pauseStruct.reason} after pipeline success`,
    );
    this.sessionManager.emit('message', {
      type: 'pr_pause_cleared',
      prNumber: job.prNumber,
      repo: job.repo,
    });
  }
}
