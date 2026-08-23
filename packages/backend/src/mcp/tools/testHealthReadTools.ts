import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getFlaggedFlakyTestsRollup,
  getBaseHealthRemediationTestTracking,
} from '../../db/queries';

/** Per-connection context the test-health read tool is scoped to. */
export interface TestHealthReadToolContext {
  projectId: string;
}

/** Flagged-flaky-test rollup entry — see flagged_flaky_tests_rollup. */
interface FlakyRollupEntry {
  testId: string;
  name: string;
  sampleCount: number;
  transitionCount: number;
}

/** Open/closed base-health remediation claim state for one test id. */
interface RemediationTrackingState {
  testId: string;
  remediationTaskId: string | null;
  remediationTaskOpen: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Registers `testHealth.getFlakyHistory` — the read-only aggregated
 * test-run/flakiness lookup a grooming/investigation session dereferences
 * instead of re-running the test suite itself to "confirm" or "refute" a
 * flakiness/base-health claim. Wraps the precomputed
 * flagged_flaky_tests_rollup table (via getFlaggedFlakyTestsRollup) and the
 * per-test base_health_remediation_test_tracking claim state (via
 * getBaseHealthRemediationTestTracking) — both already computed/maintained
 * by FlakyTestRollupJob and baseHealthRemediationFiling.ts respectively.
 * Always-on for any session resolving to a project — same precedent as
 * `gateSeed.getState`.
 */
export function registerTestHealthReadTools(
  server: McpServer,
  ctx: TestHealthReadToolContext,
): void {
  server.registerTool(
    'testHealth.getFlakyHistory',
    {
      title: 'Fetch aggregated test-run/flakiness history for a project',
      description:
        "Read-only: returns { rollup, tracking } — the orchestrator's own accumulated flaky-test evidence, never a fresh test run. `rollup` is the flagged_flaky_tests_rollup entries (each { testId, name, sampleCount, transitionCount }, recomputed every 15 minutes from full pass/fail history) currently flagged as flaky. `tracking` is the base_health_remediation_test_tracking claim state (each { testId, remediationTaskId, remediationTaskOpen, createdAt, updatedAt }) for tests ever confirmed base-failing. Pass optional `testId` to scope both arrays to a single test — an unflagged test with no tracking row returns { rollup: [], tracking: [] } rather than throwing. A single ad hoc local test run cannot substitute for this: a flaky test has no guaranteed per-execution failure rate, so this accumulated history is the source of truth to consult and cite.",
      inputSchema: { testId: z.string().optional() },
    },
    async (args) => {
      const rollupRows = getFlaggedFlakyTestsRollup(ctx.projectId);
      const rollup: FlakyRollupEntry[] = rollupRows
        .filter((row) => !args.testId || row.testId === args.testId)
        .map((row) => ({
          testId: row.testId,
          name: row.name,
          sampleCount: row.sampleCount,
          transitionCount: row.transitionCount,
        }));

      const trackedTestIds = args.testId
        ? [args.testId]
        : Array.from(new Set(rollupRows.map((row) => row.testId)));
      const tracking: RemediationTrackingState[] = trackedTestIds
        .map((testId) => {
          const row = getBaseHealthRemediationTestTracking(
            ctx.projectId,
            testId,
          );
          if (!row) return null;
          return {
            testId: row.test_id,
            remediationTaskId: row.remediation_task_id,
            remediationTaskOpen: row.remediation_task_open === 1,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
        })
        .filter((entry): entry is RemediationTrackingState => entry !== null);

      return {
        content: [{ type: 'text', text: JSON.stringify({ rollup, tracking }) }],
      };
    },
  );
}
