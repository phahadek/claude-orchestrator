import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getFlaggedFlakyTestsRollupForTests } from '../../db/queries';
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

/**
 * Registers `testHealth.getFlakyHistory` — the read-only flip-rate lookup a
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
