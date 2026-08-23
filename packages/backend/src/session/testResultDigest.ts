import type { StructuredTestResult } from '../db/types';

/**
 * Failing tests shown by name/id before the digest elides the rest — keeps
 * the delivered message bounded regardless of how large a suite's failure
 * count grows, while still surfacing enough detail to act on.
 */
const DEFAULT_MAX_FAILURES_SHOWN = 20;

export interface TestResultDigestOptions {
  maxFailuresShown?: number;
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
