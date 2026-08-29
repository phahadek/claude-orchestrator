import crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../logger';
import {
  getEventsBySession,
  getTaskNoOpAttempts,
  bumpTaskNoOpAttempts,
  getSession,
} from '../db/queries';
import { typedGetSetting } from '../config/settings';
import { renderNoOpInvestigationPrompt } from './reviewUtils';
import type { GitHubClient } from './GitHubClient';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { ServerMessage } from '../ws/types';
import { eventKind } from '../session/eventKind';
import { recordEvent } from '../audit/AuditLog';

/**
 * Recency gate shared by the no-op investigation spawn (sessionRecovery.ts)
 * and the retry-verdict apply below: run() returning does not mean the CLI
 * subprocess has exited, so a session can still be advancing its event
 * stream after recovery starts. Reuses session_inert_threshold_seconds — the
 * same "genuinely gone quiet" bar StalledPRReconciler/OrphanedTaskSweeper
 * apply elsewhere — rather than trusting ended_at or session status, neither
 * of which tracks whether the subprocess is still emitting events.
 */
export function isSessionStreamQuiet(
  sessionId: string,
  nowMs: number = Date.now(),
): boolean {
  const session = getSession(sessionId);
  const lastEventAt = session?.last_event_at ?? null;
  if (lastEventAt === null) return true;
  const quietMs = typedGetSetting('session_inert_threshold_seconds') * 1000;
  return nowMs - lastEventAt >= quietMs;
}

function recordInvestigationFailure(
  ctx: Pick<NoOpInvestigatorContext, 'taskId' | 'projectId'>,
  investigatorSessionId: string,
  stage: string,
  reason: string,
): void {
  try {
    recordEvent({
      event_type: 'no_op_investigation_failed',
      actor_type: 'system',
      actor_id: investigatorSessionId,
      project_id: ctx.projectId || null,
      task_id: ctx.taskId || null,
      payload: { stage, reason },
    });
  } catch (e) {
    logger.error(
      `[NoOpInvestigator] recordEvent(no_op_investigation_failed) failed: ${e}`,
    );
  }
}

export type NoOpVerdict =
  | { kind: 'resolved'; resolvedByPrUrl: string; reason: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'human'; reason: string };

/**
 * Shared "already resolved elsewhere" disposition: closes the task Done and
 * records the resolving evidence as an implementation note, so a Done with
 * no PR of its own is explicable later. Used both by this investigator's own
 * `resolved` verdict (reached via a secondary investigator session) and by
 * routes/stagedIntents.ts's maybeAutoResolveCodeNoOp (reached directly, when
 * a standard/ops session already did that investigation itself and named the
 * evidence in its own planning.noOp `reason`) — one place for "what closing
 * a task via an already-satisfied no-op durably records" to avoid the two
 * paths drifting apart.
 */
export async function applyResolvedNoOp(
  taskBackend: TaskBackend,
  taskId: string,
  evidenceText: string,
): Promise<void> {
  try {
    await taskBackend.updateStatus(taskId, '✅ Done');
  } catch (e) {
    logger.error(
      `[NoOpInvestigator] updateStatus(Done) failed for ${taskId}:`,
      e,
    );
  }
  try {
    await taskBackend.appendImplementationNote(taskId, evidenceText);
  } catch (e) {
    logger.error(
      `[NoOpInvestigator] appendImplementationNote failed for ${taskId}:`,
      e,
    );
  }
}

export interface NoOpInvestigatorContext {
  taskId: string;
  taskUrl: string;
  projectContextUrl: string;
  projectId: string;
  noOpSessionId: string;
  baseBranch: string;
  featureBranchName: string | undefined;
  repo: string;
  taskCreatedAt: string;
}

export interface INoOpSessionManager extends EventEmitter {
  start(
    taskUrl: string,
    projectContextUrl: string,
    options: {
      sessionId: string;
      sessionType: 'review';
      customPrompt: string;
      projectId: string;
      taskName?: string;
      taskId?: string;
    },
  ): string;
}

/** Parse a NoOpVerdict from a text string. Returns null if not found or invalid. */
export function tryParseNoOpVerdict(text: string): NoOpVerdict | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    if (
      parsed.kind === 'resolved' &&
      typeof parsed.resolvedByPrUrl === 'string' &&
      typeof parsed.reason === 'string'
    ) {
      return {
        kind: 'resolved',
        resolvedByPrUrl: parsed.resolvedByPrUrl,
        reason: parsed.reason,
      };
    }
    if (parsed.kind === 'retry' && typeof parsed.reason === 'string') {
      return { kind: 'retry', reason: parsed.reason };
    }
    if (parsed.kind === 'human' && typeof parsed.reason === 'string') {
      return { kind: 'human', reason: parsed.reason };
    }
  } catch {
    // not parseable
  }
  return null;
}

function extractVerdictFromEvents(sessionId: string): NoOpVerdict | null {
  const events = getEventsBySession(sessionId);
  for (const ev of events) {
    if (eventKind(ev) === 'text') {
      try {
        const parsed = JSON.parse(ev.payload) as Record<string, unknown>;
        if (parsed.type === 'assistant') {
          const message = parsed.message as
            | { content?: Array<{ type: string; text?: string }> }
            | undefined;
          for (const block of message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              const verdict = tryParseNoOpVerdict(block.text);
              if (verdict) return verdict;
            }
          }
        }
      } catch {
        // skip
      }
    }
  }
  return null;
}

function waitForNoOpVerdict(
  sessionManager: INoOpSessionManager,
  sessionId: string,
): Promise<NoOpVerdict | null> {
  return new Promise<NoOpVerdict | null>((resolve) => {
    const cleanup = () => sessionManager.off('message', handler);

    const handler = (msg: ServerMessage) => {
      if (
        !('sessionId' in msg) ||
        (msg as { sessionId?: string }).sessionId !== sessionId
      )
        return;

      if (
        msg.type === 'session_event' &&
        (msg as { eventType?: string }).eventType === 'text'
      ) {
        const content = (msg as { content?: string }).content ?? '';
        try {
          const event = JSON.parse(content) as Record<string, unknown>;
          if (event.type === 'assistant') {
            const message = event.message as
              | { content?: Array<{ type: string; text?: string }> }
              | undefined;
            for (const block of message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                const verdict = tryParseNoOpVerdict(block.text);
                if (verdict) {
                  cleanup();
                  resolve(verdict);
                  return;
                }
              }
            }
          }
        } catch {
          // not parseable, continue
        }
        return;
      }

      if (msg.type === 'session_ended') {
        cleanup();
        // Try one last scan of stored events for a verdict emitted before session_ended.
        const verdict = extractVerdictFromEvents(sessionId);
        // If no parseable verdict found, resolve null — caller must NOT mutate task status.
        resolve(verdict);
      }
    };

    sessionManager.on('message', handler);
  });
}

export class NoOpInvestigator {
  constructor(
    private readonly sessionManager: INoOpSessionManager,
    private readonly taskBackend: TaskBackend,
    private readonly githubClient: GitHubClient | undefined,
  ) {}

  async investigate(ctx: NoOpInvestigatorContext): Promise<void> {
    const {
      taskId,
      taskUrl,
      projectContextUrl,
      projectId,
      noOpSessionId,
      baseBranch,
      repo,
      taskCreatedAt,
    } = ctx;

    const investigatorSessionId = crypto.randomUUID();

    let taskMarkdown = '';
    let taskTitle = taskId;
    try {
      taskMarkdown = await this.taskBackend.fetchTaskPage(taskId);
      // Extract the task name from the first heading if available
      const firstHeading = taskMarkdown.match(/^#\s+(.+)$/m);
      if (firstHeading) taskTitle = firstHeading[1];
    } catch (e) {
      logger.error(`[NoOpInvestigator] fetchTaskPage failed for ${taskId}:`, e);
      recordInvestigationFailure(
        ctx,
        investigatorSessionId,
        'fetch_task_page',
        String(e),
      );
    }

    const noOpSessionEvents = getEventsBySession(noOpSessionId);

    let mergedPRs: Array<{
      number: number;
      title: string;
      url: string;
      mergedAt: string;
    }> = [];
    let recentCommits: Array<{
      sha: string;
      message: string;
      author: string;
      date: string;
    }> = [];

    if (this.githubClient && repo) {
      try {
        mergedPRs = await this.githubClient.listMergedPRsSince(
          repo,
          baseBranch,
          taskCreatedAt,
        );
      } catch (e) {
        logger.error(`[NoOpInvestigator] listMergedPRsSince failed:`, e);
        recordInvestigationFailure(
          ctx,
          investigatorSessionId,
          'list_merged_prs_since',
          String(e),
        );
      }
      try {
        recentCommits = await this.githubClient.listCommitsSince(
          repo,
          baseBranch,
          taskCreatedAt,
        );
      } catch (e) {
        logger.error(`[NoOpInvestigator] listCommitsSince failed:`, e);
        recordInvestigationFailure(
          ctx,
          investigatorSessionId,
          'list_commits_since',
          String(e),
        );
      }
    }

    const prompt = renderNoOpInvestigationPrompt({
      taskTitle,
      taskMarkdown,
      noOpSessionEvents,
      mergedPRs,
      recentCommits,
      sessionId: investigatorSessionId,
      taskId,
    });

    // Attach listener BEFORE start() to avoid missing fast verdicts.
    const verdictPromise = waitForNoOpVerdict(
      this.sessionManager,
      investigatorSessionId,
    );

    try {
      await this.sessionManager.start(taskUrl, projectContextUrl, {
        sessionId: investigatorSessionId,
        sessionType: 'review',
        customPrompt: prompt,
        projectId,
        taskName: `[no-op investigation] ${taskTitle}`,
        taskId: taskId ?? undefined,
      });
    } catch (e) {
      logger.error(
        `[NoOpInvestigator] sessionManager.start failed — sessionId=${investigatorSessionId} taskId=${taskId} reason=${String(e)}`,
      );
      recordInvestigationFailure(
        ctx,
        investigatorSessionId,
        'session_manager_start',
        String(e),
      );
      return;
    }

    let verdict: NoOpVerdict | null;
    try {
      verdict = await Promise.race([
        verdictPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 10 * 60 * 1000),
        ),
      ]);
    } catch (e) {
      logger.error(
        `[NoOpInvestigator] verdict wait failed — sessionId=${investigatorSessionId} taskId=${taskId} reason=${String(e)}`,
      );
      recordInvestigationFailure(
        ctx,
        investigatorSessionId,
        'verdict_wait',
        String(e),
      );
      return;
    }

    if (!verdict) {
      logger.error(
        `[NoOpInvestigator] session ended with no parseable verdict — sessionId=${investigatorSessionId} taskId=${taskId} — leaving task status unchanged`,
      );
      recordInvestigationFailure(
        ctx,
        investigatorSessionId,
        'no_parseable_verdict',
        'session ended without a parseable verdict',
      );
      return;
    }

    await applyNoOpVerdict(verdict, ctx, this.taskBackend, this.githubClient);
  }
}

/**
 * Applies an investigator verdict to the task. Exported (rather than a
 * private class method) so the retry-verdict liveness gate below can be
 * driven directly in tests without spinning up a full investigate() run.
 */
export async function applyNoOpVerdict(
  verdict: NoOpVerdict,
  ctx: NoOpInvestigatorContext,
  taskBackend: TaskBackend,
  githubClient: GitHubClient | undefined,
): Promise<void> {
  const { taskId, repo, featureBranchName, noOpSessionId, projectId } = ctx;

  if (verdict.kind === 'resolved') {
    await applyResolvedNoOp(
      taskBackend,
      taskId,
      `Auto-resolved by investigator: ${verdict.resolvedByPrUrl} — ${verdict.reason}`,
    );
    if (githubClient && repo && featureBranchName) {
      try {
        await githubClient.deleteBranch(repo, featureBranchName);
      } catch (e) {
        logger.error(
          `[NoOpInvestigator] deleteBranch(${featureBranchName}) failed:`,
          e,
        );
      }
    }
    return;
  }

  if (verdict.kind === 'retry') {
    if (!isSessionStreamQuiet(noOpSessionId)) {
      logger.warn(
        `[NoOpInvestigator] abstaining from retry verdict for ${taskId} — session ${noOpSessionId} still shows recent event-stream activity`,
      );
      try {
        recordEvent({
          event_type: 'no_op_verdict_abstained',
          actor_type: 'system',
          actor_id: noOpSessionId,
          project_id: projectId || null,
          task_id: taskId || null,
          payload: {
            reason: 'recent_event_stream_activity',
            verdictKind: 'retry',
          },
        });
      } catch (e) {
        logger.error(
          `[NoOpInvestigator] recordEvent(no_op_verdict_abstained) failed: ${e}`,
        );
      }
      return;
    }

    const existing = getTaskNoOpAttempts(taskId);
    const retryCount = existing?.retry_count ?? 0;
    if (retryCount === 0) {
      bumpTaskNoOpAttempts(taskId);
      try {
        await taskBackend.updateStatus(taskId, '🗂️ Ready');
      } catch (e) {
        logger.error(
          `[NoOpInvestigator] updateStatus(Ready) failed for ${taskId}:`,
          e,
        );
      }
      return;
    }
    // retry_count >= 1 — fall through to human branch
  }

  // verdict.kind === 'human' OR retry budget exhausted
  try {
    await taskBackend.updateStatus(taskId, '🚫 Blocked');
  } catch (e) {
    logger.error(
      `[NoOpInvestigator] updateStatus(Blocked) failed for ${taskId}:`,
      e,
    );
  }
  try {
    const reason =
      verdict.kind === 'retry'
        ? `Retry budget exhausted. Last investigator verdict: ${verdict.reason}`
        : verdict.reason;
    await taskBackend.updateNotes(taskId, reason);
  } catch (e) {
    logger.error(`[NoOpInvestigator] updateNotes failed for ${taskId}:`, e);
  }
}
