/**
 * The long-excused signal (gateReconciler.reconcileLongExcusedSignals): one
 * deduped, self-clearing session-less gate.verify mirror per (project, test)
 * whose 'breadth_signature' excusals span long_excused_signal_hours.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { ProjectService } from '../../projects/ProjectService.js';
import {
  configureGateItemMirrorSink,
  reconcileHumanObservationMirrors,
} from '../gateReconciler.js';
import {
  stageIntent,
  withdrawGateVerifyMirror,
} from '../../routes/stagedIntents.js';
import {
  transitionStagedIntent,
  insertTestRequestRun,
  insertTestRunResults,
  setSetting,
  listActiveGateVerifyMirrors,
} from '../../db/queries.js';

const PROJECT = 'proj-long-excused';
const TEST_ID = 'suite > sub_minute';
const HOUR = 3_600_000;
const T0 = Date.now() - 48 * HOUR;
let seq = 0;

function addResult(
  outcome: 'failed' | 'passed',
  at: number,
  excusedReason: string | null,
): void {
  const runId = `run-${seq++}`;
  insertTestRequestRun(
    runId,
    PROJECT,
    `hash-${runId}`,
    null,
    at,
    null,
    undefined,
    undefined,
    'running',
    'full',
    null,
    `/tmp/wt-${runId}`,
  );
  insertTestRunResults(
    runId,
    PROJECT,
    [{ test_id: TEST_ID, name: 'sub_minute', outcome, duration_ms: 1 }],
    null,
    false,
  );
  db.prepare(
    `UPDATE test_run_results SET created_at = @at, excused_at = @ex, excused_reason = @reason
     WHERE test_request_run_id = @runId`,
  ).run({
    at,
    ex: excusedReason ? at : null,
    reason: excusedReason,
    runId,
  });
}

function live() {
  return listActiveGateVerifyMirrors('long-excused');
}

beforeAll(() => {
  ProjectService.create({
    id: PROJECT,
    name: 'Long Excused',
    projectDir: '/tmp/proj-long-excused',
  });
});

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM audit_log').run();
  setSetting('long_excused_signal_hours', '6');
  configureGateItemMirrorSink({
    stageMirror() {},
    retireMirror(id, reason) {
      withdrawGateVerifyMirror(id, reason);
    },
    stageLongExcused({ project, testId, episodeStart, latestExcusedAt }) {
      stageIntent(
        'gate.verify',
        {
          origin: 'long-excused',
          project,
          testId,
          episodeStart,
          latestExcusedAt,
        },
        project,
        null,
        null,
        `Long-excused: ${testId}`,
      );
    },
  });
});

describe('long-excused signal', () => {
  it('opens exactly one item once excusals span 6h, and ticks do not duplicate it', () => {
    addResult('failed', T0, 'breadth_signature');
    addResult('failed', T0 + 7 * HOUR, 'breadth_signature');
    reconcileHumanObservationMirrors();
    reconcileHumanObservationMirrors();
    expect(live()).toHaveLength(1);
  });

  it('does not open before the span is reached', () => {
    addResult('failed', T0, 'breadth_signature');
    addResult('failed', T0 + 2 * HOUR, 'breadth_signature');
    reconcileHumanObservationMirrors();
    expect(live()).toHaveLength(0);
  });

  it('never opens for legacy breadth_corpus excusals', () => {
    addResult('failed', T0, 'breadth_corpus');
    addResult('failed', T0 + 20 * HOUR, 'breadth_corpus');
    reconcileHumanObservationMirrors();
    expect(live()).toHaveLength(0);
  });

  it('follows the long_excused_signal_hours setting', () => {
    addResult('failed', T0, 'breadth_signature');
    addResult('failed', T0 + 7 * HOUR, 'breadth_signature');
    setSetting('long_excused_signal_hours', '12');
    reconcileHumanObservationMirrors();
    expect(live()).toHaveLength(0);
    setSetting('long_excused_signal_hours', '6');
    reconcileHumanObservationMirrors();
    expect(live()).toHaveLength(1);
  });

  it('auto-withdraws after 3 distinct other-origin passes past the latest excusal', () => {
    addResult('failed', T0, 'breadth_signature');
    addResult('failed', T0 + 7 * HOUR, 'breadth_signature');
    reconcileHumanObservationMirrors();
    expect(live()).toHaveLength(1);
    for (let i = 1; i <= 3; i++) addResult('passed', T0 + 8 * HOUR + i, null);
    reconcileHumanObservationMirrors();
    expect(live()).toHaveLength(0);
  });

  it('a dismissal holds for the episode and a fresh episode after a clear re-opens', () => {
    addResult('failed', T0, 'breadth_signature');
    addResult('failed', T0 + 7 * HOUR, 'breadth_signature');
    reconcileHumanObservationMirrors();
    transitionStagedIntent(live()[0].id, 'rejected', {
      dispositionReason: 'dismissed',
    });
    reconcileHumanObservationMirrors();
    expect(live()).toHaveLength(0);

    for (let i = 1; i <= 3; i++) addResult('passed', T0 + 8 * HOUR + i, null);
    reconcileHumanObservationMirrors();
    expect(live()).toHaveLength(0);

    addResult('failed', T0 + 10 * HOUR, 'breadth_signature');
    addResult('failed', T0 + 17 * HOUR, 'breadth_signature');
    reconcileHumanObservationMirrors();
    expect(live()).toHaveLength(1);
  });
});
