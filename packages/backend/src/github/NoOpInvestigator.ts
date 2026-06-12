import crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  getEventsBySession,
  getTaskNoOpAttempts,
  bumpTaskNoOpAttempts,
} from '../db/queries';
import { renderNoOpInvestigationPrompt } from './reviewUtils';
import type { GitHubClient } from './GitHubClient';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { ServerMessage } from '../ws/types';
import { eventKind } from '../session/eventKind';

export type NoOpVerdict =
  | { kind: 'resolved'; resolvedByPrUrl: string; reason: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'human'; reason: string };

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
      console.error(
        `[NoOpInvestigator] fetchTaskPage failed for ${taskId}:`,
        e,
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
        console.error(`[NoOpInvestigator] listMergedPRsSince failed:`, e);
      }
      try {
        recentCommits = await this.githubClient.listCommitsSince(
          repo,
          baseBranch,
          taskCreatedAt,
        );
      } catch (e) {
        console.error(`[NoOpInvestigator] listCommitsSince failed:`, e);
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
      console.error(
        `[NoOpInvestigator] sessionManager.start failed — sessionId=${investigatorSessionId} taskId=${taskId} reason=${String(e)}`,
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
      console.error(
        `[NoOpInvestigator] verdict wait failed — sessionId=${investigatorSessionId} taskId=${taskId} reason=${String(e)}`,
      );
      return;
    }

    if (!verdict) {
      console.error(
        `[NoOpInvestigator] session ended with no parseable verdict — sessionId=${investigatorSessionId} taskId=${taskId} — leaving task status unchanged`,
      );
      return;
    }

    await this.applyVerdict(verdict, ctx, investigatorSessionId);
  }

  private async applyVerdict(
    verdict: NoOpVerdict,
    ctx: NoOpInvestigatorContext,
    _investigatorSessionId: string,
  ): Promise<void> {
    const { taskId, repo, featureBranchName } = ctx;

    if (verdict.kind === 'resolved') {
      try {
        await this.taskBackend.updateStatus(taskId, '✅ Done');
      } catch (e) {
        console.error(
          `[NoOpInvestigator] updateStatus(Done) failed for ${taskId}:`,
          e,
        );
      }
      try {
        await this.taskBackend.appendImplementationNote(
          taskId,
          `Auto-resolved by investigator: ${verdict.resolvedByPrUrl} — ${verdict.reason}`,
        );
      } catch (e) {
        console.error(
          `[NoOpInvestigator] appendImplementationNote failed for ${taskId}:`,
          e,
        );
      }
      if (this.githubClient && repo && featureBranchName) {
        try {
          await this.githubClient.deleteBranch(repo, featureBranchName);
        } catch (e) {
          console.error(
            `[NoOpInvestigator] deleteBranch(${featureBranchName}) failed:`,
            e,
          );
        }
      }
      return;
    }

    if (verdict.kind === 'retry') {
      const existing = getTaskNoOpAttempts(taskId);
      const retryCount = existing?.retry_count ?? 0;
      if (retryCount === 0) {
        bumpTaskNoOpAttempts(taskId);
        try {
          await this.taskBackend.updateStatus(taskId, '🗂️ Ready');
        } catch (e) {
          console.error(
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
      await this.taskBackend.updateStatus(taskId, '🚫 Blocked');
    } catch (e) {
      console.error(
        `[NoOpInvestigator] updateStatus(Blocked) failed for ${taskId}:`,
        e,
      );
    }
    try {
      const reason =
        verdict.kind === 'retry'
          ? `Retry budget exhausted. Last investigator verdict: ${verdict.reason}`
          : verdict.reason;
      await this.taskBackend.updateNotes(taskId, reason);
    } catch (e) {
      console.error(`[NoOpInvestigator] updateNotes failed for ${taskId}:`, e);
    }
  }
}
