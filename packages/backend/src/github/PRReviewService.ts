import { getEventsBySession, setPRReviewResult, getPRByNumber, setReviewSessionId } from '../db/queries';
import type { GitHubClient } from './GitHubClient';
import type { NotionClient } from '../notion/NotionClient';
import type { SessionManager } from '../session/SessionManager';
import type { PullRequest, PRDiff } from './types';
import type { NotionTaskPage } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';
import type { SessionEvent } from '../db/types';

export interface ReviewDimension {
  name: string;
  passed: boolean;
  notes: string;
}

export interface PRReviewResult {
  prNumber: number;
  repo: string;
  verdict: 'approved' | 'needs_changes' | 'incomplete' | 'error';
  dimensions?: ReviewDimension[];
  summary: string;
  reviewedAt: string;
}

export class PRReviewService {
  constructor(
    private github: GitHubClient,
    private notion: NotionClient,
    private sessionManager: SessionManager,
    private readonly defaultProjectId: string = '',
    private readonly defaultProjectContextUrl: string = '',
  ) {}

  async reviewPR(
    prNumber: number,
    repo: string,
    projectId: string = this.defaultProjectId,
    projectContextUrl: string = this.defaultProjectContextUrl,
  ): Promise<PRReviewResult> {
    const prRow = getPRByNumber(prNumber, repo);
    if (!prRow) {
      throw new Error(`PR #${prNumber} in ${repo} not found in database`);
    }

    const [prData, diffData] = await Promise.all([
      this.github.listOpenPRs().then((prs) => {
        const found = prs.find((p) => p.id === prNumber);
        if (!found) throw new Error(`PR #${prNumber} not found on GitHub`);
        return found;
      }),
      this.github.fetchDiff(prNumber),
    ]);

    if (!prRow.notion_task_id) {
      throw new Error(`PR #${prNumber} has no linked Notion task`);
    }

    const taskPage = await this.notion.fetchTaskPage(prRow.notion_task_id);
    const taskUrl = `https://www.notion.so/${prRow.notion_task_id}`;
    const prompt = this.buildPrompt(prData, diffData, taskPage);

    const sessionId = this.sessionManager.start(taskUrl, projectContextUrl, {
      sessionType: 'review',
      customPrompt: prompt,
      projectId,
    });

    // Persist the review session pairing immediately
    setReviewSessionId(prNumber, repo, sessionId);

    return this.waitForVerdict(sessionId, prNumber, repo);
  }

  /**
   * Send a re-review follow-up message to an existing review session and wait
   * for the next verdict JSON block in the event stream.
   */
  async sendReReview(
    reviewSessionId: string,
    prNumber: number,
    repo: string,
    iteration: number,
    maxIterations: number = 3,
  ): Promise<PRReviewResult> {
    const msg =
      `The PR has been updated (new commits detected). Please re-review the changes. ` +
      `This is review iteration ${iteration}/${maxIterations}.`;
    this.sessionManager.send(reviewSessionId, msg);
    return this.waitForVerdict(reviewSessionId, prNumber, repo);
  }

  /**
   * Listen to session_event messages for `sessionId` and resolve with the
   * first verdict JSON block found in an assistant message.
   * Falls back to parseReviewResult over stored events if session_ended fires first.
   */
  private waitForVerdict(sessionId: string, prNumber: number, repo: string): Promise<PRReviewResult> {
    return new Promise<PRReviewResult>((resolve) => {
      const cleanup = () => {
        this.sessionManager.off('message', handler);
      };

      const handler = (msg: ServerMessage) => {
        if (!('sessionId' in msg) || msg.sessionId !== sessionId) return;

        if (msg.type === 'session_event' && msg.eventType === 'text') {
          const result = this.tryParseVerdictFromRawEvent(msg.content, prNumber, repo);
          if (result) {
            cleanup();
            setPRReviewResult(prNumber, repo, JSON.stringify(result));
            resolve(result);
          }
          return;
        }

        if (msg.type === 'session_ended') {
          cleanup();
          // Fallback: parse from stored events
          const events = getEventsBySession(sessionId);
          const result = this.parseReviewResult(events, prNumber, repo);
          setPRReviewResult(prNumber, repo, JSON.stringify(result));
          resolve(result);
        }
      };

      this.sessionManager.on('message', handler);
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
      const content = msg?.content as Array<Record<string, unknown>> | undefined;
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
  private tryParseVerdict(
    text: string,
  ): { verdict: PRReviewResult['verdict']; dimensions: ReviewDimension[]; summary: string } | null {
    try {
      const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
      if (
        typeof parsed.verdict === 'string' &&
        Array.isArray(parsed.dimensions) &&
        typeof parsed.summary === 'string'
      ) {
        return {
          verdict: parsed.verdict as PRReviewResult['verdict'],
          dimensions: parsed.dimensions as ReviewDimension[],
          summary: parsed.summary,
        };
      }
    } catch {
      // Not JSON or wrong shape
    }
    return null;
  }

  buildPrompt(pr: PullRequest, diff: PRDiff, task: NotionTaskPage): string {
    const MAX_DIFF_CHARS = 12000;
    let diffText = diff.diff;
    if (diffText.length > MAX_DIFF_CHARS) {
      diffText = diffText.slice(0, MAX_DIFF_CHARS) + '\n\n[diff truncated — exceeded 12000 characters]';
    }

    return `You are a code reviewer. Compare the following GitHub PR against its Notion task specification.
Respond ONLY with a JSON object — no preamble, no markdown fences.

## PR Metadata
Title: ${pr.title}
Description: ${pr.body ?? '(none)'}
Head branch: ${pr.headBranch}

## PR Diff
${diffText}

## Notion Task Specification
### Summary
${task.summarySection || task.name}

### Context (Implementation Spec)
${task.contextSection}

### Acceptance Criteria
${task.acceptanceCriteria}

### Files / Paths Affected
${task.filesSection}

## Your task
Evaluate the PR across exactly these 4 dimensions and respond with this JSON schema:
{
  "verdict": "approved" | "needs_changes" | "incomplete",
  "dimensions": [
    { "name": "Title and description vs task Summary",        "passed": bool, "notes": "..." },
    { "name": "Diff vs Context spec",                         "passed": bool, "notes": "..." },
    { "name": "Diff vs Acceptance Criteria",                  "passed": bool, "notes": "..." },
    { "name": "Changed files vs Files/paths affected list",   "passed": bool, "notes": "..." }
  ],
  "summary": "2–4 sentence overall assessment"
}
verdict rules: "approved" = all 4 passed. "needs_changes" = 1–3 passed. "incomplete" = 0 passed.

For the "Changed files vs Files/paths affected list" dimension: Pass if all changed files are either listed in the task OR are necessary downstream updates caused by the listed changes (e.g., updating call sites after a type change, adjusting tests for modified behavior, fixing imports). Fail only if the PR touches files unrelated to the task's intent.`;
  }

  parseReviewResult(events: SessionEvent[], prNumber: number, repo: string): PRReviewResult {
    const textParts: string[] = [];

    for (const ev of events) {
      try {
        const parsed = JSON.parse(ev.payload) as Record<string, unknown>;
        if (parsed.type === 'assistant') {
          const msg = parsed.message as Record<string, unknown> | undefined;
          const content = msg?.content as Array<Record<string, unknown>> | undefined;
          if (content) {
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                textParts.push(block.text);
              }
            }
          }
        }
      } catch {
        // Skip unparseable events
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
      };
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
}
