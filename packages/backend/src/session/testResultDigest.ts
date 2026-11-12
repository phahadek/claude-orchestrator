import type { StructuredTestResult } from '../db/types';

/**
 * Failing tests shown by name/id before the digest elides the rest — keeps
 * the delivered message bounded regardless of how large a suite's failure
 * count grows, while still surfacing enough detail to act on.
 */
const DEFAULT_MAX_FAILURES_SHOWN = 20;

export interface TestResultDigestOptions {
  maxFailuresShown?: number;
  /** Supplied by callers for a run that did not pass. */
  runFailure?: {
    failedCommand: string | null;
    outputTail: string;
    /** Set when the run was killed by its time or memory budget. */
    kind?: 'timeout' | 'oom';
    durationMs?: number | null;
    /** test_timeout_sec (seconds) for timeout, test_max_rss_mb for oom. */
    limit?: number;
  };
  /** When set, failing tests render as unattributed (indicator lines / grouped) with `knownCount` collapsed. */
  unattributed?: { view: UnattributedView; knownCount: number };
  /** The run the digest describes; enables the failure-detail pointer on the plain path. */
  runId?: string | null;
}

export interface UnattributedFailure {
  test_id: string;
  name: string;
  failure_message?: string | null;
  failure_trace_excerpt?: string | null;
}

/** Per-test breadth/flip numbers plus the thresholds they are shown against. */
export interface UnattributedView {
  runId: string | null;
  breadthN: number;
  flipWindowW: number;
  /** X: more unattributed failing ids than this renders grouped, not per-test. */
  massBreakageThreshold: number;
  /** Populated only when the unattributed count is within the threshold. */
  indicators: Map<string, { breadth: number; flips: number }>;
}

const MAX_GROUPS_SHOWN = 5;

/** One pointer line per digest, or null when the run is unknown or no listed failure has stored detail. */
export function failureDetailPointer(
  runId: string | null | undefined,
  tests: UnattributedFailure[],
): string | null {
  const hasDetail = tests.some(
    (t) =>
      (t.failure_message ?? '').length > 0 ||
      (t.failure_trace_excerpt ?? '').length > 0,
  );
  if (!runId || !hasDetail) return null;
  return `_Failure detail: call mcp__orchestrator__testHealth_getTestTrace with { runId: "${runId}", testId: "<a test id above>" } — that test's stored message and trace, up to 8 KB._`;
}

/** Module of a test id: the file part before "::", else everything before the last "/" segment's test name. */
function testIdModule(testId: string): string {
  const sep = testId.indexOf('::');
  if (sep > 0) return testId.slice(0, sep);
  const slash = testId.lastIndexOf('/');
  if (slash > 0) return testId.slice(0, slash);
  const segments = testId.split('.');
  const idx = segments.findIndex((s) => /^test_/.test(s));
  return idx >= 0 ? segments.slice(0, idx + 1).join('.') : testId;
}

/**
 * Renders unattributed failing tests (already-attributed ones collapse into
 * "+N known failures"): one indicator line per test when within the
 * mass-breakage threshold, else the top groups by test-id module.
 */
export function renderUnattributedFailures(
  tests: UnattributedFailure[],
  knownCount: number,
  view: UnattributedView,
): string[] {
  const lines: string[] = [];
  if (tests.length > view.massBreakageThreshold) {
    const groups = new Map<
      string,
      { count: number; messages: Map<string, number> }
    >();
    for (const t of tests) {
      const mod = testIdModule(t.test_id);
      const g = groups.get(mod) ?? { count: 0, messages: new Map() };
      g.count++;
      const msg = (t.failure_message ?? '').trim().split('\n')[0].slice(0, 200);
      if (msg) g.messages.set(msg, (g.messages.get(msg) ?? 0) + 1);
      groups.set(mod, g);
    }
    const sorted = [...groups.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    );
    lines.push(
      `**Mass breakage:** ${tests.length} unattributed failing tests (threshold ${view.massBreakageThreshold}) — top groups by module:`,
    );
    for (const [mod, g] of sorted.slice(0, MAX_GROUPS_SHOWN)) {
      const top = [...g.messages.entries()].sort((a, b) => b[1] - a[1])[0];
      lines.push(
        `- \`${mod}\` — ${g.count} failing` +
          (top ? `; most common: ${top[0]}` : ''),
      );
    }
    if (sorted.length > MAX_GROUPS_SHOWN) {
      lines.push(`- … ${sorted.length - MAX_GROUPS_SHOWN} more module(s)`);
    }
  } else {
    for (const t of tests) {
      const ind = view.indicators.get(t.test_id);
      lines.push(
        `- \`${t.test_id}\` — ${t.name} [breadth ${ind?.breadth ?? 0}/${view.breadthN}, flips ${ind?.flips ?? 0}/${view.flipWindowW}]`,
      );
    }
  }
  const pointer = failureDetailPointer(view.runId, tests);
  if (pointer) lines.push(pointer);
  if (knownCount > 0) lines.push('', `+${knownCount} known failures`);
  return lines;
}

const AWAITING_DISPOSITION_INSTRUCTION =
  "**Wait:** no failing test was excused — the failure corpus does not yet show these failures on enough other sessions' trees to attribute them elsewhere, and nothing has established that they are unrelated to your change; treat them as possibly yours. If other sessions later record the same failures, you will be woken at most once with a re-attribution. Do not re-run the unchanged tree in the meantime.";

/** Appends the wait instruction to a delivered digest only when the run row carries the awaiting-disposition marker. */
export function appendAwaitingDispositionInstruction(
  digest: string,
  awaitingDisposition: boolean,
): string {
  return awaitingDisposition
    ? `${digest}\n\n${AWAITING_DISPOSITION_INSTRUCTION}`
    : digest;
}

/**
 * Informational slow-test lines for the session's latest run: one per flagged
 * test, or a single skipped line for a contended run. Never affects the gate.
 */
export function appendSlowTestNotice(
  digest: string,
  verdict: {
    status: 'clean' | 'contended' | 'disabled';
    flagged: { testId: string; addedMs: number }[];
  },
  ceilingSec: number,
): string {
  if (verdict.status === 'disabled') return digest;
  const lines =
    verdict.status === 'contended'
      ? ['Slow-test check skipped (contended run).']
      : verdict.flagged.map(
          (f) =>
            `Slow test: \`${f.testId}\` added ${(f.addedMs / 1000).toFixed(1)}s (ceiling ${ceilingSec}s)`,
        );
  return lines.length > 0 ? `${digest}\n\n${lines.join('\n')}` : digest;
}

/**
 * Same digest as buildTestResultDigest, rendered from a run-outcome accessor
 * result (orchestration/runTestOutcomes.ts) so it still works after the
 * run's structured_result has been cleared. Returns null when the run has no
 * recorded tests.
 */
export function buildTestResultDigestFromOutcomes(
  outcomes: {
    incomplete?: boolean;
    failingTests: {
      test_id: string;
      name: string;
      failure_message?: string | null;
      failure_trace_excerpt?: string | null;
    }[];
    totals: {
      passed: number;
      failed: number;
      skipped: number;
      errors: number;
      total: number;
    };
  },
  opts: TestResultDigestOptions = {},
): string | null {
  const { totals, failingTests } = outcomes;
  if (totals.total === 0) return null;

  const failedCount = Math.max(
    totals.failed + totals.errors,
    failingTests.length,
  );
  const otherCount = totals.total - totals.passed - failedCount;
  const maxShown = opts.maxFailuresShown ?? DEFAULT_MAX_FAILURES_SHOWN;
  const shown = failingTests.slice(0, maxShown);
  const elidedCount = failingTests.length - shown.length;

  const lines: string[] = [
    `**Test results:** ${totals.passed} passed, ${failedCount} failed` +
      (otherCount > 0 ? `, ${otherCount} other` : '') +
      ` (${totals.total} total)`,
  ];
  if (opts.unattributed) {
    if (failingTests.length > 0 || opts.unattributed.knownCount > 0) {
      lines.push(
        '',
        ...renderUnattributedFailures(
          failingTests,
          opts.unattributed.knownCount,
          opts.unattributed.view,
        ),
      );
    }
  } else if (shown.length > 0) {
    lines.push('', '**Failing tests:**');
    for (const t of shown) {
      lines.push(`- \`${t.test_id}\` — ${t.name}`);
    }
    if (elidedCount > 0) {
      lines.push(
        '',
        `_...${elidedCount} more failing test${elidedCount === 1 ? '' : 's'} elided._`,
      );
    }
    const pointer = failureDetailPointer(opts.runId, shown);
    if (pointer) lines.push('', pointer);
  }
  if (opts.runFailure && (failedCount === 0 || outcomes.incomplete)) {
    const rf = opts.runFailure;
    const cmd = rf.failedCommand ?? 'unknown command';
    const secs =
      typeof rf.durationMs === 'number'
        ? `${Math.round(rf.durationMs / 1000)}s`
        : 'unknown duration';
    const headline =
      rf.kind === 'timeout'
        ? `**Test run timed out:** \`${cmd}\` was killed after ${secs} against the project's test_timeout_sec of ${rf.limit ?? 'unknown'}s. This is a lane time-budget failure, not a test verdict; any report rows are partial.`
        : rf.kind === 'oom'
          ? `**Test run was OOM-killed:** \`${cmd}\` exceeded the project's test_max_rss_mb of ${rf.limit ?? 'unknown'} MB after ${secs}. This is a memory-budget failure, not a test verdict; any report rows are partial.`
          : `**Failure outside the structured report:** \`${cmd}\` exited non-zero.`;
    lines.push('', headline, '', '```', opts.runFailure.outputTail, '```');
  }
  return lines.join('\n');
}

/**
 * Renders a run's structured_result (junit-xml normalized JSON, see
 * StructuredTestResult) into a bounded, session-facing digest: pass/fail/
 * other counts plus failing test ids/names, capped with an elision note —
 * the digest-vs-raw-truncation counterpart to gateItemVerifier's pattern of
 * turning a structured record into a rendered summary rather than dumping
 * the record itself.
 *
 * Returns null when structuredResultJson doesn't parse or carries no tests
 * (e.g. a lane execution error that never produced a structured result) —
 * callers fall back to the raw-truncation path in that case, since there is
 * nothing structured to render.
 */
export function buildTestResultDigest(
  structuredResultJson: string,
  opts: TestResultDigestOptions = {},
): string | null {
  let parsed: StructuredTestResult;
  try {
    parsed = JSON.parse(structuredResultJson) as StructuredTestResult;
  } catch {
    return null;
  }

  const tests = (parsed.suites ?? []).flatMap((suite) => suite.tests ?? []);
  if (tests.length === 0) return null;

  const failing = tests.filter((t) => t.outcome === 'failed');
  const passedCount = tests.filter((t) => t.outcome === 'passed').length;
  const otherCount = tests.length - passedCount - failing.length;

  const maxShown = opts.maxFailuresShown ?? DEFAULT_MAX_FAILURES_SHOWN;
  const shown = failing.slice(0, maxShown);
  const elidedCount = failing.length - shown.length;

  const lines: string[] = [
    `**Test results:** ${passedCount} passed, ${failing.length} failed` +
      (otherCount > 0 ? `, ${otherCount} other` : '') +
      ` (${tests.length} total)`,
  ];

  if (shown.length > 0) {
    lines.push('', '**Failing tests:**');
    for (const t of shown) {
      lines.push(`- \`${t.id}\` — ${t.name}`);
    }
    if (elidedCount > 0) {
      lines.push(
        '',
        `_...${elidedCount} more failing test${elidedCount === 1 ? '' : 's'} elided._`,
      );
    }
  }

  return lines.join('\n');
}
