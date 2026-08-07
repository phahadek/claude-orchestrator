import { logger } from '../logger';
import { getEventsBySession, markSessionDone } from '../db/queries';
import {
  computeSizeSignal,
  isOversized,
  SIZE_ABSOLUTE_FLOOR,
  SIZE_FILE_RATIO_LIMIT,
  type SizeSignal,
} from './GitHubClient';
import type { DiffSource } from './DiffSource';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { parseSection, parseExpectedSize } from '../notion/NotionClient';
import type { SessionManager } from '../session/SessionManager';
import type { ServerMessage } from '../ws/types';
import type { SessionEvent } from '../db/types';

// Below the 30-min stall-detector cutoff, mirroring PRReviewService's
// VERDICT_TIMEOUT_MS — the depth pass fails open on timeout (see
// runDepthReview's catch), so this only bounds how long a PR sits in the
// "approved, depth review pending" state before the operator sees nothing
// happened rather than blocking merge.
const DEPTH_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;

export const SIZE_DIMENSION_NAME = 'Size proportionality';
const SECURITY_DIMENSION_NAME = 'Security';
const CONCURRENCY_DIMENSION_NAME = 'Concurrency';
const RELIABILITY_DIMENSION_NAME = 'Reliability / crash';
const DATA_INTEGRITY_DIMENSION_NAME = 'Data integrity & parsing correctness';

/** Dimension names a depth-pass finding may fail on that route to escalate rather than auto-fix. */
const NON_SIZE_DIMENSION_NAMES: ReadonlySet<string> = new Set([
  SECURITY_DIMENSION_NAME,
  CONCURRENCY_DIMENSION_NAME,
  RELIABILITY_DIMENSION_NAME,
  DATA_INTEGRITY_DIMENSION_NAME,
]);

export interface DepthReviewDimension {
  name: string;
  passed: boolean;
  notes: string;
}

export interface DepthReviewResult {
  verdict: 'pass' | 'fail' | 'error';
  dimensions: DepthReviewDimension[];
  summary: string;
  /** True when at least one non-size dimension failed — the caller should escalate. */
  hasNonSizeFailure: boolean;
  /** True when the only failing dimension is size-proportionality — the caller should route to auto-fix feedback. */
  sizeOnlyFailure: boolean;
}

const DEPTH_REVIEW_JSON_SCHEMA_BLOCK = `Respond ONLY with a JSON object — no preamble, no markdown fences.

This is a DEPTH review — it runs only after the diff already passed conformance
review (title/description vs Summary, diff vs Context spec, diff vs Acceptance
Criteria, changed files vs Files/paths affected). Do NOT re-evaluate those —
judge only whether the diff is correct and safe.

Evaluate the diff across exactly these 5 dimensions, in priority order, and
respond with this JSON schema:
{
  "verdict": "pass" | "fail",
  "dimensions": [
    { "name": "${SECURITY_DIMENSION_NAME}",           "passed": bool, "notes": "..." },
    { "name": "${CONCURRENCY_DIMENSION_NAME}",         "passed": bool, "notes": "..." },
    { "name": "${RELIABILITY_DIMENSION_NAME}",         "passed": bool, "notes": "..." },
    { "name": "${DATA_INTEGRITY_DIMENSION_NAME}",      "passed": bool, "notes": "..." },
    { "name": "${SIZE_DIMENSION_NAME}",                "passed": bool, "notes": "..." }
  ],
  "summary": "2–4 sentence overall assessment"
}
verdict rules: "pass" = all 5 passed, "fail" = any dimension failed.

Dimension guidance:
- "${SECURITY_DIMENSION_NAME}": Fail when unsafe or unvalidated input reaches an
  interpreted context (SQL/shell/HTML/template) or an authorization-sensitive
  code path (auth checks, access control, credential handling) without proper
  escaping, parameterization, or validation.
- "${CONCURRENCY_DIMENSION_NAME}": Fail on races, deadlocks, or cross-request/
  cross-session state bleed — e.g. shared mutable state without synchronization,
  a check-then-act sequence that isn't atomic, or a resource that outlives the
  request/session it was scoped to.
- "${RELIABILITY_DIMENSION_NAME}": Fail on unhandled errors that can crash the
  process or leave it in a bad state, and resource-lifecycle bugs (leaked
  handles/connections/timers, missing cleanup on the error path).
- "${DATA_INTEGRITY_DIMENSION_NAME}": Fail on parsing/serialization bugs that
  can silently corrupt or misinterpret data — off-by-one or boundary errors,
  incorrect encoding/decoding, lossy type coercion, or a schema mismatch
  between what's written and what's read back.
- "${SIZE_DIMENSION_NAME}": Pass when the PR is within the size budget signaled
  below OR when any overflow is necessary corollary work (dead-code removal,
  forced call-site updates, test/fixture adjustments). Fail only when the diff
  is materially larger than the task scope demands — scope creep, unrelated
  cleanup, or speculative refactors. Note your reasoning so a re-reviewer can
  audit the call.`;

export class DepthReviewService {
  constructor(
    private sessionManager: SessionManager,
    /** Optional fixed task backend — tests only. Production resolves per-call via getTaskBackend(projectId). */
    private taskBackendOverride: TaskBackend | undefined,
    /** Override the verdict wait timeout (ms). For tests only. */
    private readonly timeoutMs: number = DEPTH_REVIEW_TIMEOUT_MS,
  ) {}

  private resolveBackend(projectId: string): TaskBackend {
    return this.taskBackendOverride ?? getTaskBackend(projectId);
  }

  /**
   * Run the depth review pass for an already-conformance-approved PR. Fails
   * open: any error (fetch failure, session launch failure, parse failure,
   * timeout) is caught, logged, and resolves to null rather than throwing —
   * a depth-pass failure must never block merge, which stays gated solely on
   * the conformance verdict (see ReviewOrchestrator's caller).
   */
  async runDepthReview(
    prNumber: number,
    repo: string,
    diffSource: DiffSource,
    projectId: string,
    projectContextUrl: string,
    taskId: string | null,
  ): Promise<DepthReviewResult | null> {
    try {
      const diff = await diffSource.fetchDiff();

      let taskBody = '';
      if (taskId) {
        try {
          taskBody = await this.resolveBackend(projectId).fetchTaskPage(taskId);
        } catch (e) {
          logger.warn(
            `[DepthReviewService] fetchTaskPage failed for PR #${prNumber} (task ${taskId}): ${e}`,
          );
        }
      }

      const sizeSignal = computeSizeSignal(
        diff,
        parseSection(taskBody, 'files'),
        parseExpectedSize(taskBody),
      );
      const prompt = this.buildPrompt(prNumber, diff, taskBody, sizeSignal);

      const sessionId = crypto.randomUUID();
      const verdictPromise = this.waitForVerdict(sessionId);
      this.watchForSessionEnd(sessionId);

      await this.sessionManager.start(projectContextUrl, projectContextUrl, {
        sessionId,
        sessionType: 'depth_review',
        customPrompt: prompt,
        projectId,
        taskName: `Depth review of PR #${prNumber}`,
        taskId: taskId ?? undefined,
      });

      const result = await verdictPromise;
      if (!result) return null;
      return this.classify(result);
    } catch (e) {
      logger.warn(
        `[DepthReviewService] depth review failed for PR #${prNumber} (${repo}) — failing open (merge stays gated on conformance alone): ${e}`,
      );
      return null;
    }
  }

  /** Derive the escalate/auto-fix routing signals from the raw dimension list. */
  private classify(parsed: {
    verdict: string;
    dimensions: DepthReviewDimension[];
    summary: string;
  }): DepthReviewResult {
    const dimensions = parsed.dimensions;
    const failing = dimensions.filter((d) => !d.passed);
    const hasNonSizeFailure = failing.some((d) =>
      NON_SIZE_DIMENSION_NAMES.has(d.name),
    );
    const sizeOnlyFailure =
      failing.length > 0 &&
      !hasNonSizeFailure &&
      failing.every((d) => d.name === SIZE_DIMENSION_NAME);
    const verdict: DepthReviewResult['verdict'] =
      parsed.verdict === 'pass' || parsed.verdict === 'fail'
        ? (parsed.verdict as 'pass' | 'fail')
        : failing.length === 0
          ? 'pass'
          : 'fail';
    return {
      verdict,
      dimensions,
      summary: parsed.summary,
      hasNonSizeFailure,
      sizeOnlyFailure,
    };
  }

  private buildPrompt(
    prNumber: number,
    diff: string,
    taskBody: string,
    sizeSignal: SizeSignal,
  ): string {
    return `You are a depth reviewer for PR #${prNumber}. Its conformance review already
passed. Evaluate the diff below for real defects beyond spec-conformance.

## Diff
${diff}

## Task Specification
${taskBody || '(no task specification available)'}

${this.formatSizeSignalSection(sizeSignal)}

## Your task
${DEPTH_REVIEW_JSON_SCHEMA_BLOCK}`;
  }

  private formatSizeSignalSection(signal: SizeSignal): string {
    const ratio =
      signal.specFileCount > 0
        ? signal.oversizeRatio.toFixed(2)
        : 'n/a (no spec file list)';
    const flagged = isOversized(signal);
    const totalLoc = signal.linesAdded + signal.linesDeleted;
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
      `- file-ratio limit: ${SIZE_FILE_RATIO_LIMIT}x`,
      budgetLine,
      `- Verdict: ${flagged ? '⚠️ OVERSIZED per heuristic — review whether the overflow is necessary corollary work.' : 'In budget vs. task spec.'}`,
      '',
      'Generated-file diffs (package-lock.json, lockfiles, .snap, .svg) are excluded from the LOC count.',
    ].join('\n');
  }

  /**
   * Conclude the depth-review session once its process actually exits.
   * No PR ever links to a depth-review session — pull_requests carries only
   * session_id/review_session_id, both scoped to the conformance review —
   * so nothing else ever transitions this session to a terminal status.
   * This runs independently of waitForVerdict, whose own listener typically
   * unsubscribes early (as soon as it parses a verdict out of a text event),
   * well before the session's process has actually exited.
   *
   * Only status 'idle' — AgentSession.handleCleanExit's non-planning
   * clean-exit signal, the only way a depth-review session (which never
   * opens a PR) exits successfully — is concluded here. A status that's
   * already terminal ('error'/'killed', e.g. the session was destroyed
   * mid-work or crashed) is left alone: it already reflects what actually
   * happened and must not be stomped with 'done'.
   */
  private watchForSessionEnd(sessionId: string): void {
    const handler = (msg: ServerMessage) => {
      if (!('sessionId' in msg) || msg.sessionId !== sessionId) return;
      if (msg.type !== 'session_ended') return;
      this.sessionManager.off('message', handler);
      if (msg.status !== 'idle') return;
      markSessionDone(sessionId, Date.now(), null, 'depth_review_service');
    };
    this.sessionManager.on('message', handler);
  }

  /**
   * Listen for the depth-review session's verdict, same shape as
   * PRReviewService.waitForVerdict but tolerant of a missing/unparseable
   * verdict — resolves null (never throws) so the caller can fail open.
   */
  private waitForVerdict(sessionId: string): Promise<{
    verdict: string;
    dimensions: DepthReviewDimension[];
    summary: string;
  } | null> {
    return new Promise((resolve) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        this.sessionManager.off('message', handler);
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      };

      const handler = (msg: ServerMessage) => {
        if (!('sessionId' in msg) || msg.sessionId !== sessionId) return;

        if (msg.type === 'session_event' && msg.eventType === 'text') {
          const result = this.tryParseVerdictFromRawEvent(msg.content);
          if (result) {
            cleanup();
            resolve(result);
          }
          return;
        }

        if (msg.type === 'session_ended') {
          cleanup();
          const events = getEventsBySession(sessionId);
          resolve(this.parseFromEvents(events));
        }
      };

      this.sessionManager.on('message', handler);

      timeoutHandle = setTimeout(() => {
        cleanup();
        logger.warn(
          `[DepthReviewService] waitForVerdict timed out after ${Math.round(this.timeoutMs / 60000)} min for session ${sessionId}`,
        );
        const events = getEventsBySession(sessionId);
        resolve(this.parseFromEvents(events));
      }, this.timeoutMs);
    });
  }

  private parseFromEvents(events: SessionEvent[]): {
    verdict: string;
    dimensions: DepthReviewDimension[];
    summary: string;
  } | null {
    for (let i = events.length - 1; i >= 0; i--) {
      const recovered = this.tryParseVerdictFromRawEvent(events[i].payload);
      if (recovered) return recovered;
    }
    return null;
  }

  private tryParseVerdictFromRawEvent(rawEventPayload: string): {
    verdict: string;
    dimensions: DepthReviewDimension[];
    summary: string;
  } | null {
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
          if (parsed) return parsed;
        }
      }
    } catch {
      // Not parseable — skip
    }
    return null;
  }

  private tryParseVerdict(text: string): {
    verdict: string;
    dimensions: DepthReviewDimension[];
    summary: string;
  } | null {
    const candidate = this.extractJsonCandidate(text.trim());
    if (!candidate) return null;
    const repaired = candidate.replace(/,(\s*[}\]])/g, '$1');
    return (
      this.parseVerdictObject(candidate) ?? this.parseVerdictObject(repaired)
    );
  }

  private parseVerdictObject(json: string): {
    verdict: string;
    dimensions: DepthReviewDimension[];
    summary: string;
  } | null {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      if (typeof parsed.verdict !== 'string') return null;
      const dimensions = Array.isArray(parsed.dimensions)
        ? (parsed.dimensions as DepthReviewDimension[])
        : [];
      const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
      return { verdict: parsed.verdict, dimensions, summary };
    } catch {
      return null;
    }
  }

  /** Strip markdown fences and extract the first top-level `{...}` JSON object from `text`. */
  private extractJsonCandidate(text: string): string | null {
    const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (fenceMatch) return fenceMatch[1].trim();

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
}
