import {
  getTestRequestRunById,
  getPreSessionDurationMedians,
  listPassedDurationSamplesForRun,
  listTestRequestRunsForPrSession,
} from '../db/queries';
import type { TestRequestRunRow } from '../db/types';
import { getProjectById } from '../config';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { isTestIdTouchedByChangedFiles } from '../session/test-runner';
import { logger } from '../logger';

export interface SlowTestConfig {
  slow_test_ceiling_sec: number;
  slow_test_allow: string[];
}

interface SlowTestFlag {
  testId: string;
  kind: 'new' | 'touched';
  addedMs: number;
}

export interface SlowTestVerdict {
  status: 'clean' | 'contended' | 'disabled';
  flagged: SlowTestFlag[];
}

const NON_VERDICT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'timeout',
  'worker_crash',
  'oom_killed',
  'execution_failed',
  'tool_infra_failure',
  'interrupted_queued',
  'interrupted_running',
  'superseded',
  'cancelled',
  'runner_unreachable',
]);

/** The duration-admission predicate, plus: settled, executed, and not a targeted run. */
function isCleanJudgeableRun(run: TestRequestRunRow): boolean {
  return (
    (run.state === 'passed' || run.state === 'failed') &&
    run.run_kind !== 'targeted' &&
    !run.coverage_source_run_id &&
    run.concurrent_run_count === 0 &&
    (run.foreign_concurrent_run_count ?? 0) === 0 &&
    !run.oom_killed &&
    !(run.failure_reason && NON_VERDICT_FAILURE_REASONS.has(run.failure_reason))
  );
}

/** Reads the ceiling/allow-list from the project's base checkout, never a session worktree. */
export function loadSlowTestConfig(projectId: string): SlowTestConfig | null {
  const project = getProjectById(projectId);
  if (!project) return null;
  try {
    const cfg = loadOrchestratorConfig(project.projectDir);
    return {
      slow_test_ceiling_sec: cfg.slow_test_ceiling_sec,
      slow_test_allow: cfg.slow_test_allow,
    };
  } catch (err) {
    logger.warn(
      `[slowTestVerdict] config load failed for project ${projectId}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

export function evaluateSlowTestVerdict(
  runId: string,
  sessionId: string,
  changedFiles: string[],
  config: SlowTestConfig,
): SlowTestVerdict {
  const ceilingMs = config.slow_test_ceiling_sec * 1000;
  if (!(ceilingMs > 0)) return { status: 'disabled', flagged: [] };
  const run = getTestRequestRunById(runId);
  if (!run || !isCleanJudgeableRun(run)) {
    return { status: 'contended', flagged: [] };
  }

  const allow = new Set(config.slow_test_allow);
  const candidates = listPassedDurationSamplesForRun(
    runId,
    ceilingMs,
  ).filter((c) => !allow.has(c.test_id));
  if (candidates.length === 0) return { status: 'clean', flagged: [] };
  const medians = getPreSessionDurationMedians(
    candidates.map((c) => c.test_id),
    sessionId,
    runId,
  );

  const flagged: SlowTestFlag[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.test_id)) continue;
    seen.add(c.test_id);
    const baseline = medians.get(c.test_id);
    if (baseline === undefined) {
      if (c.duration_ms > ceilingMs) {
        flagged.push({
          testId: c.test_id,
          kind: 'new',
          addedMs: c.duration_ms,
        });
      }
      continue;
    }
    if (!isTestIdTouchedByChangedFiles(c.test_id, c.name, changedFiles).touched)
      continue;
    const added = c.duration_ms - baseline;
    if (added > ceilingMs) {
      flagged.push({ testId: c.test_id, kind: 'touched', addedMs: added });
    }
  }
  flagged.sort((a, b) => b.addedMs - a.addedMs);
  return { status: 'clean', flagged };
}

/**
 * Evaluates the newest clean run of the session on its tree, walking back past
 * contended, OOM-killed, timed-out, and targeted runs. Null when none qualifies.
 */
export function evaluateLatestCleanSlowTestVerdict(
  projectId: string,
  sessionId: string,
  worktreePath: string | null,
  changedFiles: string[],
  config: SlowTestConfig,
): SlowTestVerdict | null {
  if (!(config.slow_test_ceiling_sec > 0)) return null;
  const runs = listTestRequestRunsForPrSession(
    projectId,
    sessionId,
    worktreePath,
  );
  for (const run of runs) {
    if (run.session_id !== sessionId || !isCleanJudgeableRun(run)) continue;
    return evaluateSlowTestVerdict(run.id, sessionId, changedFiles, config);
  }
  return null;
}
