import { getEventsBySession, setPRReviewResult, getPRByNumber } from '../db/queries.js';
import type { GitHubClient } from './GitHubClient.js';
import type { NotionClient } from '../notion/NotionClient.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { PullRequest, PRDiff } from './types.js';
import type { NotionTaskPage } from '../notion/NotionClient.js';
import type { ServerMessage } from '../ws/types.js';
import type { SessionEvent } from '../db/types.js';

export interface ReviewDimension {
  name: string;
  passed: boolean;
  notes: string;
}

export interface PRReviewResult {
  prNumber: number;
  repo: string;
  verdict: 'approved' | 'needs_changes' | 'incomplete';
  dimensions: ReviewDimension[];
  summary: string;
  reviewedAt: string;
}

export class PRReviewService {
  constructor(
    private github: GitHubClient,
    private notion: NotionClient,
    private sessionManager: SessionManager,
    private projectId: string,
    private projectContextUrl: string,
  ) {}

  async reviewPR(prNumber: number, repo: string): Promise<PRReviewResult> {
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

    const sessionId = this.sessionManager.start(taskUrl, this.projectContextUrl, {
      sessionType: 'review',
      customPrompt: prompt,
      projectId: this.projectId,
    });

    // Wait for session completion via EventEmitter
    await new Promise<void>((resolve) => {
      const handler = (msg: ServerMessage) => {
        if (msg.type === 'session_ended' && msg.sessionId === sessionId) {
          this.sessionManager.off('message', handler);
          resolve();
        }
      };
      this.sessionManager.on('message', handler);
    });

    // Parse result from stored events
    const events = getEventsBySession(sessionId);
    const result = this.parseReviewResult(events, prNumber, repo);

    setPRReviewResult(prNumber, repo, JSON.stringify(result));
    return result;
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
verdict rules: "approved" = all 4 passed. "needs_changes" = 1–3 passed. "incomplete" = 0 passed.`;
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
    let parsedResult: Record<string, unknown>;
    try {
      parsedResult = JSON.parse(combined) as Record<string, unknown>;
    } catch (err) {
      return {
        prNumber,
        repo,
        verdict: 'incomplete',
        dimensions: [],
        summary: `Failed to parse Claude output as JSON: ${String(err)}. Raw output: ${combined.slice(0, 500)}`,
        reviewedAt: new Date().toISOString(),
      };
    }

    return {
      prNumber,
      repo,
      verdict: (parsedResult.verdict as PRReviewResult['verdict']) ?? 'incomplete',
      dimensions: (parsedResult.dimensions as ReviewDimension[]) ?? [],
      summary: (parsedResult.summary as string) ?? '',
      reviewedAt: new Date().toISOString(),
    };
  }
}
