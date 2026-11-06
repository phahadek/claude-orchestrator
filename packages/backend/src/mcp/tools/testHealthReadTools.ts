import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getFlaggedFlakyTestsRollupForTests,
  getTestRequestRunById,
} from '../../db/queries';
import { getRunTestOutcomes } from '../../orchestration/runTestOutcomes';
import { typedGetSetting } from '../../config/settings';

/** Per-connection context the test-health read tool is scoped to. */
export interface TestHealthReadToolContext {
  projectId: string;
}

/** One explicit flip-rate answer per requested test id. */
interface FlakyHistoryEntry {
  testId: string;
  flipRateFlagged: boolean;
  transitionCount: number | null;
  sampleCount: number | null;
  flipThreshold: number;
}

const TRACE_TOOL_MAX_CHARS = 8192;
const TRUNCATION_MARKER = '\n…[message truncated]…\n';

/** Cuts `text` to at most `max` characters as head + marker + tail. */
function cutHeadAndTail(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARKER.length) return text.slice(0, Math.max(0, max));
  const keep = max - TRUNCATION_MARKER.length;
  const head = Math.ceil(keep / 2);
  return (
    text.slice(0, head) +
    TRUNCATION_MARKER +
    text.slice(text.length - (keep - head))
  );
}

/**
 * Registers `testHealth.getTestTrace` — the bounded per-test failure
 * message/trace read, and `testHealth.getFlakyHistory` —the read-only flip-rate lookup a
 * grooming/investigation session dereferences instead of re-running the test
 * suite to "confirm" or "refute" a flakiness claim. Reads the precomputed
 * flagged_flaky_tests_rollup scoped to the requested ids. Always-on for any
 * session resolving to a project — same precedent as `gateSeed.getState`.
 */
export function registerTestHealthReadTools(
  server: McpServer,
  ctx: TestHealthReadToolContext,
): void {
  server.registerTool(
    'testHealth.getTestTrace',
    {
      title: 'Fetch the stored failure message and trace for one failing test',
      description:
        'Read-only: pass `runId` and `testId` (from a test result digest) and get { status, message, trace, truncated, messageLength, traceLength }. status is one of ok, no_detail (failed but nothing stored), not_failing (no failing row for that test in the run), run_not_found (missing, pruned or another project). Message plus trace are capped at 8192 characters; an over-long message is cut to head and tail with a marker and truncated is true.',
      inputSchema: { runId: z.string().min(1), testId: z.string().min(1) },
    },
    async (args) => {
      const reply = (body: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(body) }],
      });
      const run = getTestRequestRunById(args.runId);
      if (!run || run.project_id !== ctx.projectId) {
        return reply({ status: 'run_not_found' });
      }
      const outcomes = await getRunTestOutcomes(args.runId);
      const test = outcomes.failingTests.find((t) => t.test_id === args.testId);
      if (!test) return reply({ status: 'not_failing' });
      const rawMessage = test.failure_message ?? '';
      const trace = test.failure_trace_excerpt ?? '';
      if (rawMessage.length === 0 && trace.length === 0) {
        return reply({ status: 'no_detail' });
      }
      const message = cutHeadAndTail(
        rawMessage,
        Math.max(0, TRACE_TOOL_MAX_CHARS - trace.length),
      );
      const cappedTrace = trace.slice(0, TRACE_TOOL_MAX_CHARS);
      return reply({
        status: 'ok',
        message,
        trace: cappedTrace,
        truncated: message.length !== rawMessage.length,
        messageLength: rawMessage.length,
        traceLength: trace.length,
      });
    },
  );

  server.registerTool(
    'testHealth.getFlakyHistory',
    {
      title: 'Fetch flip-rate flakiness status for specific tests',
      description:
        "Read-only: pass `testIds` (1-50 failing test ids from your run) and get { entries } — exactly one entry per distinct requested id, in request order: { testId, flipRateFlagged, transitionCount, sampleCount, flipThreshold }. flipRateFlagged is true when the test is in the orchestrator's flagged_flaky_tests_rollup (recomputed every 15 minutes) with its transitionCount/sampleCount; otherwise false with null counts. flipThreshold is the configured flip_rate_threshold_k. Flip-rate only counts same-hash pass<->fail transitions, so flipRateFlagged: false does NOT mean the test is healthy — a test failing deterministically across trees is never flagged. It is accumulated history, never a fresh test run; a single ad hoc local run cannot substitute for it.",
      inputSchema: { testIds: z.array(z.string().min(1)).min(1).max(50) },
    },
    async (args) => {
      const testIds = [...new Set(args.testIds)];
      const rows = new Map(
        getFlaggedFlakyTestsRollupForTests(ctx.projectId, testIds).map((r) => [
          r.testId,
          r,
        ]),
      );
      const flipThreshold = typedGetSetting('flip_rate_threshold_k');
      const entries: FlakyHistoryEntry[] = testIds.map((testId) => {
        const row = rows.get(testId);
        return {
          testId,
          flipRateFlagged: row !== undefined,
          transitionCount: row?.transitionCount ?? null,
          sampleCount: row?.sampleCount ?? null,
          flipThreshold,
        };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ entries }) }] };
    },
  );
}
