import {
  getEventsBySession,
  setPRReviewResult,
  getPRByNumber,
  setReviewSessionId,
  updatePRDraftStatus,
  incrementReviewIteration,
  setLastReviewedSha,
} from '../db/queries';
import type { GitHubClient } from './GitHubClient';
import {
  computeSizeSignal,
  isOversized,
  SIZE_ABSOLUTE_FLOOR,
  SIZE_FILE_RATIO_LIMIT,
  type SizeSignal,
} from './GitHubClient';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { parseSection, parseExpectedSize } from '../notion/NotionClient';
import type { SessionManager } from '../session/SessionManager';
import type { PullRequest, PRDiff } from './types';
import type { ServerMessage } from '../ws/types';
import type { SessionEvent } from '../db/types';
import type { PRMergeWatcher } from './PRMergeWatcher';
import type { AutoMerger } from './AutoMerger';

const SIZE_DIMENSION_NAME = 'Size proportionality';

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

/**
 * Shared review-instructions block: the JSON schema, verdict rules, and the
 * per-dimension guidance. Used by both the initial prompt and the re-review
 * follow-ups so the two stay in sync.
 */
const REVIEW_JSON_SCHEMA_BLOCK = `Respond ONLY with a JSON object — no preamble, no markdown fences.

Evaluate the PR across exactly these 5 dimensions and respond with this JSON schema:
{
  "verdict": "approved" | "needs_changes" | "incomplete",
  "dimensions": [
    { "name": "Title and description vs task Summary",        "passed": bool, "notes": "..." },
    { "name": "Diff vs Context spec",                         "passed": bool, "notes": "..." },
    { "name": "Diff vs Acceptance Criteria",                  "passed": bool, "notes": "..." },
    { "name": "Changed files vs Files/paths affected list",   "passed": bool, "notes": "..." },
    { "name": "${SIZE_DIMENSION_NAME}",                          "passed": bool, "notes": "..." }
  ],
  "summary": "2–4 sentence overall assessment"
}
verdict rules: "approved" = all 5 passed. "needs_changes" = 1–4 passed. "incomplete" = 0 passed.

For the "Changed files vs Files/paths affected list" dimension: Pass if all changed files are either listed in the task OR are necessary downstream updates caused by the listed changes (e.g., updating call sites after a type change, adjusting tests for modified behavior, fixing imports). Fail only if the PR touches files unrelated to the task's intent.

For the "${SIZE_DIMENSION_NAME}" dimension: Pass when the PR is within the size budget signaled above OR when any overflow is necessary corollary work — for example, deleting dead code or types that the listed changes leave unused, refactoring call sites the listed changes force to update, or test/fixture adjustments that follow from modified behavior. Fail only when the diff is materially larger than what the task scope (Summary + Acceptance Criteria + Files affected) demands, i.e. scope creep, unrelated cleanup, or speculative refactors. Note your reasoning in the "notes" field so a re-reviewer can audit the call.`;

export class PRReviewService {
  constructor(
    private github: GitHubClient,
    /**
     * Optional fixed task backend. When provided (typically by tests), all task
     * fetches/status updates go through it. In production this is undefined and
     * the backend is resolved per-call via getTaskBackend(projectId).
     */
    private taskBackendOverride: TaskBackend | undefined,
    private sessionManager: SessionManager,
    private readonly defaultProjectId: string = '',
    private readonly defaultProjectContextUrl: string = '',
  ) {}

  // Optional reference to PRMergeWatcher used to trigger an immediate mergeability
  // check after an approved verdict (so we don't wait for the next 5-min poll).
  // Set via setMergeWatcher() after both services are constructed (server.ts).
  private mergeWatcher?: PRMergeWatcher;

  setMergeWatcher(watcher: PRMergeWatcher): void {
    this.mergeWatcher = watcher;
  }

  // Optional reference to AutoMerger used to kick off the auto-merge polling
  // loop after an approved verdict on projects with autoMergeEnabled.
  private autoMerger?: AutoMerger;

  setAutoMerger(merger: AutoMerger): void {
    this.autoMerger = merger;
  }

  private resolveBackend(projectId: string): TaskBackend {
    return this.taskBackendOverride ?? getTaskBackend(projectId);
  }

  /**
   * Resolve the task spec inputs needed for size-signal computation: the
   * "Files / paths affected" section and the optional "Expected size" override.
   * Returns empty/undefined when the task lookup fails so the signal still computes.
   */
  private async fetchSizeSignalInputs(
    projectId: string,
    taskId: string | null,
  ): Promise<{ filesSection: string; expectedSize?: number }> {
    if (!taskId) return { filesSection: '' };
    try {
      const body = await this.resolveBackend(projectId).fetchTaskPage(taskId);
      return {
        filesSection: parseSection(body, 'files'),
        expectedSize: parseExpectedSize(body),
      };
    } catch (e) {
      console.warn(
        `[PRReviewService] fetchTaskPage for size signal failed (task ${taskId}):`,
        e,
      );
      return { filesSection: '' };
    }
  }

  /** Render the size signal block shown in re-review follow-up messages. */
  private renderSizeSignalForFollowUp(signal: SizeSignal): string {
    const budgetLine =
      signal.expectedSize !== undefined
        ? `- Expected size override (task budget ${signal.expectedSize}): ${signal.linesAdded + signal.linesDeleted > signal.expectedSize ? 'EXCEEDED' : 'within budget'}`
        : `- Absolute LOC floor (>${SIZE_ABSOLUTE_FLOOR}): ${signal.exceededAbsoluteFloor ? 'EXCEEDED' : 'within budget'}`;
    const ratioLine =
      signal.expectedSize !== undefined
        ? `- filesTouched / specFileCount: ${signal.specFileCount > 0 ? signal.oversizeRatio.toFixed(2) : 'n/a'} (suppressed by Expected size override)`
        : `- filesTouched / specFileCount: ${signal.specFileCount > 0 ? signal.oversizeRatio.toFixed(2) : 'n/a'}`;
    return [
      '',
      '### Refreshed Size Signal',
      `- Lines added: ${signal.linesAdded}`,
      `- Lines deleted: ${signal.linesDeleted}`,
      `- Files touched: ${signal.filesTouched}`,
      `- Files listed in task spec: ${signal.specFileCount}`,
      budgetLine,
      ratioLine,
      `- Oversized: ${isOversized(signal) ? `YES — re-evaluate ${SIZE_DIMENSION_NAME} and confirm any overflow is necessary corollary work` : 'no'}`,
      '',
    ].join('\n');
  }

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
    if (
      existingReviewSessionId &&
      this.sessionManager.isAlive(existingReviewSessionId)
    ) {
      // Register listener BEFORE sending to avoid missing a fast verdict.
      const verdictPromise = this.waitForVerdict(
        existingReviewSessionId,
        prNumber,
        repo,
      );
      const prData = await this.github.fetchPR(repo, prNumber);
      const diffData = await this.github.fetchDiff(prNumber, repo, {
        base: prData.baseBranch,
        head: prData.headBranch,
      });
      // Recompute size signal against the FULL refreshed diff each iteration.
      const { filesSection, expectedSize } = await this.fetchSizeSignalInputs(
        projectId,
        prRow.notion_task_id,
      );
      const sizeSignal = computeSizeSignal(
        diffData.diff,
        filesSection,
        expectedSize,
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
        this.renderSizeSignalForFollowUp(sizeSignal),
        REVIEW_JSON_SCHEMA_BLOCK,
      ].join('\n');
      this.sessionManager.send(existingReviewSessionId, followUp);
      const aiResult = await verdictPromise;
      const { mergeable } = await this.github.getMergeabilityWithRetry(
        prNumber,
        repo,
      );
      const sizedResult = this.appendSizeProportionalityDimension(
        aiResult,
        sizeSignal,
      );
      const finalResult = this.appendMergeConflictDimension(
        sizedResult,
        mergeable,
      );
      setPRReviewResult(prNumber, repo, JSON.stringify(finalResult));
      if (finalResult.verdict === 'approved') {
        await this.handleApprovedVerdict(
          prNumber,
          repo,
          prRow.notion_task_id,
          projectId,
        );
      }
      return finalResult;
    }

    const prData = await this.github.fetchPR(repo, prNumber);
    const diffData = await this.github.fetchDiff(prNumber, repo, {
      base: prData.baseBranch,
      head: prData.headBranch,
    });

    if (!prRow.notion_task_id) {
      throw new Error(`PR #${prNumber} has no linked Notion task`);
    }

    const taskBody = await this.resolveBackend(projectId).fetchTaskPage(
      prRow.notion_task_id,
    );
    const taskUrl = `https://www.notion.so/${prRow.notion_task_id}`;
    const prompt = this.buildPrompt(prData, diffData, taskBody);
    const sizeSignal = computeSizeSignal(
      diffData.diff,
      parseSection(taskBody, 'files'),
      parseExpectedSize(taskBody),
    );

    // Case 2: Dead existing review session — resume via sendOrResume with the
    // original session ID (do NOT generate a new one here). The returned value
    // is the actual session ID used (may be a new resumed session ID).
    if (existingReviewSessionId) {
      const resumedSessionId = await this.sessionManager.sendOrResume(
        existingReviewSessionId,
        prompt,
      );
      setReviewSessionId(prNumber, repo, resumedSessionId);
      const aiResult = await this.waitForVerdict(
        resumedSessionId,
        prNumber,
        repo,
      );
      const { mergeable } = await this.github.getMergeabilityWithRetry(
        prNumber,
        repo,
      );
      const sizedResult = this.appendSizeProportionalityDimension(
        aiResult,
        sizeSignal,
      );
      const finalResult = this.appendMergeConflictDimension(
        sizedResult,
        mergeable,
      );
      setPRReviewResult(prNumber, repo, JSON.stringify(finalResult));
      if (finalResult.verdict === 'approved') {
        await this.handleApprovedVerdict(
          prNumber,
          repo,
          prRow.notion_task_id,
          projectId,
        );
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
    const { mergeable } = await this.github.getMergeabilityWithRetry(
      prNumber,
      repo,
    );
    const sizedResult = this.appendSizeProportionalityDimension(
      aiResult,
      sizeSignal,
    );
    const finalResult = this.appendMergeConflictDimension(
      sizedResult,
      mergeable,
    );
    setPRReviewResult(prNumber, repo, JSON.stringify(finalResult));
    // Set last_reviewed_sha so the next push_detected can compare correctly.
    setLastReviewedSha(prNumber, repo, prData.headSha ?? null);
    if (finalResult.verdict === 'approved') {
      await this.handleApprovedVerdict(
        prNumber,
        repo,
        prRow.notion_task_id,
        projectId,
      );
    }
    return finalResult;
  }

  /**
   * Handle post-verdict side effects when a PR is approved: transition draft → ready
   * on GitHub, and update the Notion task status to 👀 In Review.
   * Returns true if the PR was successfully transitioned from draft to ready.
   */
  async handleApprovedVerdict(
    prNumber: number,
    repo: string,
    taskId: string | null,
    projectId?: string,
  ): Promise<boolean> {
    let draftTransitioned = false;
    try {
      await this.github.markPRReady(repo, prNumber);
      updatePRDraftStatus(prNumber, repo, 0);
      draftTransitioned = true;
    } catch (e) {
      console.warn(
        `[PRReviewService] markPRReady skipped for PR #${prNumber}:`,
        e,
      );
    }
    if (taskId) {
      const resolvedProjectId = projectId ?? this.defaultProjectId;
      try {
        await this.resolveBackend(resolvedProjectId).updateStatus(
          taskId,
          '👀 In Review',
        );
      } catch (e: unknown) {
        console.error(`[PRReviewService] task backend updateStatus failed:`, e);
      }
    }
    // Trigger an immediate mergeability check so the watcher's DB merge_state and
    // WS event reflect current state — don't wait for the next 5-min poll.
    if (this.mergeWatcher) {
      this.mergeWatcher
        .checkMergeabilityNow(prNumber, repo)
        .catch((err: unknown) =>
          console.warn(
            `[PRReviewService] checkMergeabilityNow failed for PR #${prNumber}:`,
            (err as Error).message,
          ),
        );
    }
    // Kick off the auto-merger (per-project opt-in; AutoMerger guards on the
    // project toggle and on pause_reason). Fire-and-forget — the polling loop
    // runs in the background.
    if (this.autoMerger) {
      this.autoMerger.attempt(prNumber, repo);
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
    const branches =
      prData.baseBranch && prData.headBranch
        ? { base: prData.baseBranch, head: prData.headBranch }
        : undefined;
    // Re-review uses the FULL PR diff (compare endpoint), not just the incremental
    // delta, so the size signal reflects total churn across the lifetime of the PR.
    const diffData = await this.github.fetchDiff(prNumber, repo, branches);
    const { filesSection, expectedSize } = await this.fetchSizeSignalInputs(
      projectId,
      pr.notion_task_id,
    );
    const sizeSignal = computeSizeSignal(
      diffData.diff,
      filesSection,
      expectedSize,
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
      this.renderSizeSignalForFollowUp(sizeSignal),
      REVIEW_JSON_SCHEMA_BLOCK,
    ].join('\n');

    // Increment iteration before sending so the DB reflects the new iteration
    incrementReviewIteration(prNumber, repo);

    // Send to the existing review session (resumes via --resume if it has exited)
    const resumedSessionId = await this.sessionManager.sendOrResume(
      pr.review_session_id,
      followUp,
    );
    if (resumedSessionId !== pr.review_session_id) {
      setReviewSessionId(prNumber, repo, resumedSessionId);
    }

    const aiResult = await this.waitForVerdict(
      resumedSessionId,
      prNumber,
      repo,
    );
    const { mergeable } = await this.github.getMergeabilityWithRetry(
      prNumber,
      repo,
    );
    const sizedResult = this.appendSizeProportionalityDimension(
      aiResult,
      sizeSignal,
    );
    const finalResult = this.appendMergeConflictDimension(
      sizedResult,
      mergeable,
    );
    setPRReviewResult(prNumber, repo, JSON.stringify(finalResult));
    setLastReviewedSha(prNumber, repo, pr.head_sha ?? null);
    return finalResult;
  }

  /**
   * Listen to session_event messages for `sessionId` and resolve with the
   * first verdict JSON block found in an assistant message.
   * Falls back to parseReviewResult over stored events if session_ended fires first.
   */
  private waitForVerdict(
    sessionId: string,
    prNumber: number,
    repo: string,
  ): Promise<PRReviewResult> {
    return new Promise<PRReviewResult>((resolve) => {
      const cleanup = () => {
        this.sessionManager.off('message', handler);
      };

      const handler = (msg: ServerMessage) => {
        if (!('sessionId' in msg) || msg.sessionId !== sessionId) return;

        if (msg.type === 'session_event' && msg.eventType === 'text') {
          const result = this.tryParseVerdictFromRawEvent(
            msg.content,
            prNumber,
            repo,
          );
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
      const content = msg?.content as
        | Array<Record<string, unknown>>
        | undefined;
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
  private tryParseVerdict(text: string): {
    verdict: PRReviewResult['verdict'];
    dimensions: ReviewDimension[];
    summary: string;
  } | null {
    const candidate = this.extractJsonCandidate(text.trim());
    if (!candidate) {
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
      // Not valid JSON — caller falls back to a default verdict
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
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  private appendMergeConflictDimension(
    result: PRReviewResult,
    mergeable: boolean | null,
  ): PRReviewResult {
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
      verdict = result.verdict; // Never override error/incomplete
    } else if (passedCount === dimensions.length) {
      verdict = 'approved';
    } else if (passedCount === 0) {
      verdict = 'incomplete';
    } else {
      verdict = 'needs_changes';
    }

    return { ...result, dimensions, verdict };
  }

  /**
   * Normalize the Size proportionality dimension and re-derive the overall verdict.
   * The LLM owns the pass/fail call (it sees the size signal in the prompt). When
   * the LLM forgets to emit the dimension, we synthesize one from the heuristic:
   *   - in budget → pass
   *   - oversized → fail (no justification was offered)
   * Verdict is recomputed using the same passedCount === dimensions.length pattern
   * as appendMergeConflictDimension; error/incomplete inputs are preserved.
   */
  private appendSizeProportionalityDimension(
    result: PRReviewResult,
    signal: SizeSignal,
  ): PRReviewResult {
    const existing = (result.dimensions ?? []).find(
      (d) => d.name === SIZE_DIMENSION_NAME,
    );
    let sizeDim: ReviewDimension;
    if (existing) {
      sizeDim = existing;
    } else {
      const flagged = isOversized(signal);
      sizeDim = {
        name: SIZE_DIMENSION_NAME,
        passed: !flagged,
        notes: flagged
          ? `PR exceeds size budget (added+deleted=${signal.linesAdded + signal.linesDeleted}, files=${signal.filesTouched}, spec files=${signal.specFileCount}) and reviewer did not address the overflow.`
          : `PR is within size budget (added+deleted=${signal.linesAdded + signal.linesDeleted}, files=${signal.filesTouched}, spec files=${signal.specFileCount}).`,
      };
    }

    const otherDims = (result.dimensions ?? []).filter(
      (d) => d.name !== SIZE_DIMENSION_NAME,
    );
    const dimensions = [...otherDims, sizeDim];
    const passedCount = dimensions.filter((d) => d.passed).length;

    let verdict: PRReviewResult['verdict'];
    if (result.verdict === 'error' || result.verdict === 'incomplete') {
      verdict = result.verdict; // Never override error/incomplete
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
    const sizeSignal = computeSizeSignal(
      diff.diff,
      parseSection(taskBody, 'files'),
      parseExpectedSize(taskBody),
    );
    return `You are a code reviewer. Compare the following GitHub PR against its task specification.

## PR Metadata
Title: ${pr.title}
Description: ${pr.body ?? '(none)'}
Head branch: ${pr.headBranch}

## PR Diff
${diff.diff}

## Task Specification
${taskBody}

${this.formatSizeSignalSection(sizeSignal)}

## Your task
${REVIEW_JSON_SCHEMA_BLOCK}`;
  }

  /** Render the size signal block for the reviewer prompt. */
  private formatSizeSignalSection(signal: SizeSignal): string {
    const ratio =
      signal.specFileCount > 0
        ? signal.oversizeRatio.toFixed(2)
        : 'n/a (no spec file list)';
    const flagged = isOversized(signal);
    const totalLoc = signal.linesAdded + signal.linesDeleted;
    const reasons: string[] = [];
    if (signal.expectedSize !== undefined) {
      if (totalLoc > signal.expectedSize) {
        reasons.push(
          `lines added+deleted (${totalLoc}) exceeds task-level Expected size budget of ${signal.expectedSize}`,
        );
      }
    } else {
      if (signal.exceededAbsoluteFloor) {
        reasons.push(
          `lines added+deleted (${totalLoc}) exceeds floor of ${SIZE_ABSOLUTE_FLOOR}`,
        );
      }
      if (
        signal.specFileCount > 0 &&
        signal.oversizeRatio > SIZE_FILE_RATIO_LIMIT
      ) {
        reasons.push(
          `filesTouched/specFileCount ratio (${signal.oversizeRatio.toFixed(2)}) exceeds ${SIZE_FILE_RATIO_LIMIT}×`,
        );
      }
    }
    const flag = flagged
      ? `⚠️ OVERSIZED — ${reasons.join('; ')}. Review whether the overflow is necessary corollary work.`
      : 'In budget vs. task spec.';
    const budgetLine =
      signal.expectedSize !== undefined
        ? `- Expected size override (task budget ${signal.expectedSize}, added+deleted=${totalLoc}): ${totalLoc > signal.expectedSize ? 'EXCEEDED' : 'within budget'} — file-ratio default suppressed`
        : `- Absolute LOC floor (added+deleted > ${SIZE_ABSOLUTE_FLOOR}): ${signal.exceededAbsoluteFloor ? 'EXCEEDED' : 'within budget'}`;
    return [
      '## Size Signal',
      `- Lines added: ${signal.linesAdded}`,
      `- Lines deleted: ${signal.linesDeleted}`,
      `- Files touched: ${signal.filesTouched}`,
      `- Files listed in task spec: ${signal.specFileCount}`,
      `- filesTouched / specFileCount: ${ratio}`,
      budgetLine,
      `- Verdict: ${flag}`,
      '',
      'Generated-file diffs (package-lock.json, lockfiles, .snap, .svg) are excluded from the LOC count.',
    ].join('\n');
  }

  parseReviewResult(
    events: SessionEvent[],
    prNumber: number,
    repo: string,
  ): PRReviewResult {
    // Only use text blocks from the LAST assistant message to avoid pollution
    // from earlier tool-call assistant events.
    let lastAssistantContent: Array<Record<string, unknown>> | null = null;
    for (const ev of events) {
      try {
        const parsed = JSON.parse(ev.payload) as Record<string, unknown>;
        if (parsed.type === 'assistant') {
          const msg = parsed.message as Record<string, unknown> | undefined;
          const content = msg?.content as
            | Array<Record<string, unknown>>
            | undefined;
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
