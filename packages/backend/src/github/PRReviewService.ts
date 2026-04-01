import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { config, ALLOWED_TOOLS } from '../config.js';
import { setPRReviewResult, getPRByNumber } from '../db/queries.js';
import type { GitHubClient } from './GitHubClient.js';
import type { NotionClient } from '../notion/NotionClient.js';
import type { PullRequest, PRDiff } from './types.js';
import type { NotionTaskPage } from '../notion/NotionClient.js';

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
    const prompt = this.buildPrompt(prData, diffData, taskPage);
    const result = await this.runClaude(prompt, prNumber, repo);

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

  private async runClaude(prompt: string, prNumber: number, repo: string): Promise<PRReviewResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        config.claudePath,
        [
          '--print',
          '--output-format', 'stream-json',
          '--input-format', 'stream-json',
          '--permission-mode', 'acceptEdits',
          '--allowed-tools', ...ALLOWED_TOOLS,
        ],
        { cwd: config.projectDir, stdio: ['pipe', 'pipe', 'pipe'] },
      );

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        const errorResult: PRReviewResult = {
          prNumber,
          repo,
          verdict: 'incomplete',
          dimensions: [],
          summary: 'Review timed out after 120 seconds.',
          reviewedAt: new Date().toISOString(),
        };
        resolve(errorResult);
      }, 120_000);

      proc.stdin!.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n',
      );
      proc.stdin!.end();

      const textParts: string[] = [];

      const rl = createInterface({ input: proc.stdout! });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }

        if (event.type === 'assistant') {
          const msg = event.message as Record<string, unknown> | undefined;
          const content = msg?.content as Array<Record<string, unknown>> | undefined;
          if (content) {
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                textParts.push(block.text);
              }
            }
          }
        }
      });

      proc.once('exit', () => {
        clearTimeout(timeout);
        rl.close();

        const combined = textParts.join('').trim();
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(combined) as Record<string, unknown>;
        } catch (err) {
          const errorResult: PRReviewResult = {
            prNumber,
            repo,
            verdict: 'incomplete',
            dimensions: [],
            summary: `Failed to parse Claude output as JSON: ${String(err)}. Raw output: ${combined.slice(0, 500)}`,
            reviewedAt: new Date().toISOString(),
          };
          resolve(errorResult);
          return;
        }

        const result: PRReviewResult = {
          prNumber,
          repo,
          verdict: (parsed.verdict as PRReviewResult['verdict']) ?? 'incomplete',
          dimensions: (parsed.dimensions as ReviewDimension[]) ?? [],
          summary: (parsed.summary as string) ?? '',
          reviewedAt: new Date().toISOString(),
        };
        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
}
