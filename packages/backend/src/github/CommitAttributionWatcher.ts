import { logger } from '../logger';
import { recordEvent } from '../audit/AuditLog';
import { setPauseReason } from '../db/queries';
import { ORCHESTRATOR_BOT_EMAIL } from '../session/autofix-runner';
import type { GitHubClient } from './GitHubClient';

/** Matches the AI-Authored-By trailer in a commit message. */
export const AI_TRAILER_REGEX = /^AI-Authored-By:/m;

export interface CommitInfo {
  sha: string;
  message: string;
  author?: string | null;
}

export interface AttributionCheckResult {
  checked: number;
  missing: number;
  paused: boolean;
}

/**
 * Check that all commits in a PR carry the AI-Authored-By trailer.
 * In corporate mode, missing trailers pause the PR and are audit-logged.
 * In non-corporate mode, only audit-logs (no pause).
 *
 * Returns a summary of what was found.
 */
export async function checkCommitAttribution(
  client: GitHubClient,
  repo: string,
  prNumber: number,
  sessionId: string,
  projectId: string | null,
  taskId: string | null,
  isCorporateMode: boolean,
): Promise<AttributionCheckResult> {
  let commits: CommitInfo[];
  try {
    commits = await client.getCommitsForPR(repo, prNumber);
  } catch (err) {
    logger.warn(
      `[CommitAttributionWatcher] failed to fetch commits for PR #${prNumber} in ${repo}: ${(err as Error).message}`,
    );
    return { checked: 0, missing: 0, paused: false };
  }

  let missingCount = 0;
  let shouldPause = false;

  for (const commit of commits) {
    // Skip bot-authored commits entirely — no audit events emitted
    if (commit.author === ORCHESTRATOR_BOT_EMAIL) {
      continue;
    }

    const hasAITrailer = AI_TRAILER_REGEX.test(commit.message);

    recordEvent({
      event_type: 'commit',
      actor_type: hasAITrailer ? 'ai' : 'human',
      actor_id: sessionId,
      project_id: projectId,
      task_id: taskId,
      payload: {
        sha: commit.sha,
        author: commit.author ?? null,
        has_trailer: hasAITrailer,
        pr_number: prNumber,
        repo,
      },
    });

    if (!hasAITrailer) {
      missingCount++;
      recordEvent({
        event_type: 'attribution_missing',
        actor_type: 'ai',
        actor_id: sessionId,
        project_id: projectId,
        task_id: taskId,
        payload: { sha: commit.sha, pr_number: prNumber, repo },
      });
      if (isCorporateMode) {
        shouldPause = true;
      }
    }
  }

  if (shouldPause) {
    setPauseReason(prNumber, repo, 'attribution_missing');
  }

  return {
    checked: commits.length,
    missing: missingCount,
    paused: shouldPause,
  };
}
