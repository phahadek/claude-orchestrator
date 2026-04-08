import { getEventsBySession, setPRReviewResult, getPRByNumber, setReviewSessionId, updatePRDraftStatus, incrementReviewIteration, setLastReviewedSha } from '../db/queries';
import type { GitHubClient } from './GitHubClient';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend';
import type { SessionManager } from '../session/SessionManager';
import type { PullRequest, PRDiff } from './types';
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
    private notion: TaskTrackerBackend,
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

    const existingReviewSessionId = prRow.review_session_id;

    // Case 1: Live review session exists — send follow-up with diff, do not spawn a new session.
    // review_session_id is intentionally NOT updated in this path.
    if (existingReviewSessionId && this.sessionManager.isAlive(existingReviewSessionId)) {
      // Register listener BEFORE sending to avoid missing a fast verdict.
      const verdictPromise = this.waitForVerdict(existingReviewSessionId, prNumber, repo);
      const prData = await this.github.fetchPR(repo, prNumber);
      const diffData = await this.github.fetchDiff(
        prNumber, repo,
        { base: prData.baseBranch, head: prData.headBranch },
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
        diffData.diff,
        '```',
        ``,
        `Respond with the same JSON review format as before.`,
      ].join('\n');
      this.sessionManager.send(existingReviewSessionId, followUp);
      const aiResult = await verdictPromise;
      const { mergeable } = await this.github.getMergeability(prNumber, repo);
      const finalResult = this.appendMergeConflictDimension(aiResult, mergeable);
      setPRReviewResult(prNumber, repo, JSON.stringify(finalResult));
      if (finalResult.verdict === 'approved') {
        await this.handleApprovedVerdict(prNumber, repo, prRow.notion_task_id);
      }
      return finalResult;
    }

    const prData = await this.github.fetchPR(repo, prNumber);
    const diffData = await this.github.fetchDiff(
      prNumber, repo,
      { base: prData.baseBranch, head: prData.headBranch },
    );

    if (!prRow.notion_task_id) {
      throw new Error(`PR #${prNumber} has no linked Notion task`);
    }

    const taskBody = await this.notion.fetchTaskPage(prRow.notion_task_id);
    const taskUrl = `https://www.notion.so/${prRow.notion_task_id}`;
    const prompt = this.buildPrompt(prData, diffData, taskBody);

    // Case 2: Dead existing review session — resume via sendOrResume with the
    // original session ID (do NOT generate a new one here). The returned value
    // is the actual session ID used (may be a new resumed session ID).
    if (existingReviewSessionId) {
      const resumedSessionId = await this.sessionManager.sendOrResume(existingReviewSessionId, prompt);
      setReviewSessionId(prNumber, repo, resumedSessionId);
      const aiResult = await this.waitForVerdict(resumedSessionId, prNumber, repo);
      const { mergeable } = await this.github.getMergeability(prNumber, repo);
      const finalResult = this.appendMergeConflictDimension(aiResult, mergeable);
      setPRReviewResult(prNumber, repo, JSON.stringify(finalResult));
      if (finalResult.verdict === 'approved') {
        await this.handleApprovedVerdict(prNumber, repo, prRow.notion_task_id);
      }
      return finalResult;
    }

    // Case 3: No prior review session — spawn a fresh session.
    // Generate the session ID before starting so the verdict listener can be
    // subscribed before any events are emitted. Without this, fast reviews
    // (verdict emitted within seconds, before waitForVerdict subscribes) are
    // silently missed and fall through to the timeout.
    const sessionId = crypto.randomUUID();

    // 1. Attach listener BEFORE start() — ensures no events are missed.
    const verdictPromise = this.waitForVerdict(sessionId, prNumber, repo);

    // 2. Start session with the pre-generated ID.
    this.sessionManager.start(taskUrl, projectContextUrl, {
      sessionId,
      sessionType: 'review',
      customPrompt: prompt,
      projectId,
      taskName: `#${prData.id} ${prData.title}`,
    });

    // 3. Persist the review session pairing.
    setReviewSessionId(prNumber, repo, sessionId);

    const aiResult = await verdictPromise;
    const { mergeable } = await this.github.getMergeability(prNumber, repo);
    const finalResult = this.appendMergeConflictDimension(aiResult, mergeable);
    setPRReviewResult(prNumber, repo, JSON.stringify(finalResult));
    // Set last_reviewed_sha so the next push_detected can compare correctly.
    setLastReviewedSha(prNumber, repo, prData.headSha ?? null);
    if (finalResult.verdict === 'approved') {
      await this.handleApprovedVerdict(prNumber, repo, prRow.notion_task_id);
    }
    return finalResult;
  }

  /**
   * Handle post-verdict side effects when a PR is approved: transition draft → ready
   * on GitHub, and update the Notion task status to 👀 In Review.
   * Returns true if the PR was successfully transitioned from draft to ready.
   */
  async handleApprovedVerdict(prNumber: number, repo: string, taskId: string | null): Promise<boolean> {
    let draftTransitioned = false;
    try {
      await this.github.markPRReady(repo, prNumber);
      updatePRDraftStatus(prNumber, repo, 0);
      draftTransitioned = true;
    } catch (e) {
      console.warn(`[PRReviewService] markPRReady skipped for PR #${prNumber}:`, e);
    }
    if (taskId) {
      await this.notion.updateStatus(taskId, '👀 In Review').catch((e: unknown) =>
        console.error(`[PRReviewService] Notion updateStatus failed:`, e),
      );
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
    if (!pr?.review_session_id) {
      // No paired review session — fall back to fresh review
      return this.reviewPR(prNumber, repo, projectId, projectContextUrl);
    }

    const prData = await this.github.fetchPR(repo, prNumber);
    const branches = prData.baseBranch && prData.headBranch
      ? { base: prData.baseBranch, head: prData.headBranch }
      : undefined;
    const diffData = await this.github.fetchDiff(prNumber, repo, branches);

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
      diffData.diff,
      '```',
      ``,
      `Respond with the same JSON review format as before.`,
    ].join('\n');

    // Increment iteration before sending so the DB reflects the new iteration
    incrementReviewIteration(prNumber, repo);

    // Send to the existing review session (resumes via --resume if it has exited)
    const resumedSessionId = await this.sessionManager.sendOrResume(pr.review_session_id, followUp);
    if (resumedSessionId !== pr.review_session_id) {
      setReviewSessionId(prNumber, repo, resumedSessionId);
    }

    const aiResult = await this.waitForVerdict(resumedSessionId, prNumber, repo);
    const { mergeable } = await this.github.getMergeability(prNumber, repo);
    const finalResult = this.appendMergeConflictDimension(aiResult, mergeable);
    setPRReviewResult(prNumber, repo, JSON.stringify(finalResult));
    setLastReviewedSha(prNumber, repo, pr.head_sha ?? null);
    return finalResult;
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
            resolve(result);
          }
          return;
        }

        if (msg.type === 'session_ended') {
          cleanup();
          // Fallback: parse from stored events
          const events = getEventsBySession(sessionId);
          const result = this.parseReviewResult(events, prNumber, repo);
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
    const candidate = this.extractJsonCandidate(text.trim());
    if (!candidate) {
      console.debug('[PRReviewService] tryParseVerdict: no JSON candidate found in text block');
      return null;
    }
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
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
      console.debug('[PRReviewService] tryParseVerdict: JSON.parse failed on candidate:', candidate.slice(0, 200));
    }
    return null;
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
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  private appendMergeConflictDimension(result: PRReviewResult, mergeable: boolean | null): PRReviewResult {
    // When GitHub returns null, mergeability is still being computed — skip the dimension entirely.
    if (mergeable === null) {
      return result;
    }

    const passed = mergeable === true;
    const conflictDim: ReviewDimension = {
      name: 'Merge conflicts',
      passed,
      notes: passed
        ? 'No merge conflicts detected.'
        : 'PR has merge conflicts with base branch. Rebase and resolve before re-review.',
    };

    const dimensions = [...(result.dimensions ?? []), conflictDim];
    const passedCount = dimensions.filter((d) => d.passed).length;

    let verdict: PRReviewResult['verdict'];
    if (result.verdict === 'error' || result.verdict === 'incomplete') {
      verdict = result.verdict;  // Never override error/incomplete
    } else if (passedCount === dimensions.length) {
      verdict = 'approved';
    } else if (passedCount === 0) {
      verdict = 'incomplete';
    } else {
      verdict = 'needs_changes';
    }

    return { ...result, dimensions, verdict };
  }

  buildPrompt(pr: PullRequest, diff: PRDiff, taskBody: string): string {
    return `You are a code reviewer. Compare the following GitHub PR against its task specification.
Respond ONLY with a JSON object — no preamble, no markdown fences.

## PR Metadata
Title: ${pr.title}
Description: ${pr.body ?? '(none)'}
Head branch: ${pr.headBranch}

## PR Diff
${diff.diff}

## Task Specification
${taskBody}

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
    // Only use text blocks from the LAST assistant message to avoid pollution
    // from earlier tool-call assistant events.
    let lastAssistantContent: Array<Record<string, unknown>> | null = null;
    for (const ev of events) {
      try {
        const parsed = JSON.parse(ev.payload) as Record<string, unknown>;
        if (parsed.type === 'assistant') {
          const msg = parsed.message as Record<string, unknown> | undefined;
          const content = msg?.content as Array<Record<string, unknown>> | undefined;
          if (content) lastAssistantContent = content;
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
