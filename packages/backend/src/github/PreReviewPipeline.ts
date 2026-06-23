import { logger } from '../logger';
import {
  getPRByNumber,
  getSession,
  setPRReviewResult,
  setLastReviewedSha,
  setPreReviewStage,
  setPauseReason,
  hasTestResultForSha,
  upsertTestResult,
  hasAnalyzeResultForSha,
  upsertAnalyzeResult,
  getAnalyzeResult,
  addAutofixSha,
} from '../db/queries';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { loadAutofixCommands, runAutofix } from '../session/autofix-runner';
import { runVerifyAsGate } from '../orchestration/verifyRunner';
import { runTestCommands } from '../session/test-runner';
import { runFilePollutionCheck } from '../session/filePollutionCheck';
import { formatCIFailureFeedback } from './reviewUtils';
import { recordEvent } from '../audit/AuditLog';
import type { SessionManager } from '../session/SessionManager';
import type { GitHubClient } from './GitHubClient';
import type { ReviewJob } from './types';
import type { ProjectConfig } from '../config';
import type { PauseReason } from '../db/types';

interface GateFailureDetail {
  failedCommand?: string;
  truncatedOutput?: string;
  summary: string;
  output?: string;
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
  formatFailure: (detail: GateFailureDetail) => string;
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

        let success = true;
        let summary = 'no worktree available — autofix skipped';

        if (ctx.worktreePath) {
          try {
            const result = await runAutofix(
              ctx.worktreePath,
              ctx.project.projectDir,
              cmds,
              (msg) =>
                logger.info(
                  `[PreReviewPipeline] autofix PR #${ctx.prNumber}: ${msg}`,
                ),
            );
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
      formatFailure: (detail) =>
        formatCIFailureFeedback({
          source: 'verify',
          failedCommand: detail.failedCommand,
          truncatedOutput: detail.truncatedOutput,
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
          const result = await runTestCommands(
            ctx.worktreePath,
            config.analyze,
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
          passed = result.passed;
          output = result.output;
          upsertAnalyzeResult(
            ctx.prNumber,
            ctx.repo,
            ctx.headSha,
            passed,
            output,
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

        if (hasTestResultForSha(ctx.prNumber, ctx.repo, ctx.headSha)) {
          logger.info(
            `[PreReviewPipeline] tests already ran for PR #${ctx.prNumber} SHA ${ctx.headSha.slice(0, 7)} — skipping`,
          );
          return;
        }

        const { passed, output } = await runTestCommands(
          ctx.worktreePath,
          config.test,
          config.test_timeout_sec,
          (msg) =>
            logger.info(`[PreReviewPipeline] test PR #${ctx.prNumber}: ${msg}`),
          { maxRssMb: config.test_max_rss_mb, failFast: config.test_fail_fast },
        );

        upsertTestResult(ctx.prNumber, ctx.repo, ctx.headSha, passed, output);

        logger.info(
          `[PreReviewPipeline] tests ${passed ? 'PASSED' : 'FAILED'} for PR #${ctx.prNumber} SHA ${ctx.headSha.slice(0, 7)}`,
        );
      },
    };
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

    setPRReviewResult(
      job.prNumber,
      job.repo,
      JSON.stringify({
        verdict: stage.verdict,
        summary: detail.summary,
        dimensions: [],
      }),
    );

    setLastReviewedSha(job.prNumber, job.repo, prRow?.head_sha ?? null);

    setPreReviewStage(job.prNumber, job.repo, stage.blockedStage);

    if (stage.pauseReason) {
      setPauseReason(job.prNumber, job.repo, stage.pauseReason);
    }

    const sessionId = prRow?.session_id;
    if (!sessionId) return;

    const message = stage.formatFailure(detail);
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
    stage: string,
    extra?: { summary?: string; failedCommand?: string },
  ): void {
    recordEvent({
      event_type: eventType,
      actor_type: 'system',
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
      this.emitAuditStageEvent('pipeline_stage_entered', job, stage.id);

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
          this.emitAuditStageEvent('pipeline_stage_failed', job, stage.id, {
            summary: failure.summary,
            failedCommand: failure.failedCommand,
          });
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
        this.emitAuditStageEvent('pipeline_stage_passed', job, stage.id);
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
        this.emitAuditStageEvent('pipeline_stage_passed', job, stage.id);
      }
    }

    setPreReviewStage(job.prNumber, job.repo, 'awaiting_review');
    return { passed: true };
  }
}
