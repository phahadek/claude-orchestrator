import type { PRReviewResult } from '../github/PRReviewService';
import type { DepthReviewDimension } from '../github/DepthReviewService';
import type { getDepthReviewVerdict } from '../db/queries';

export function composeReviewFixMessage(
  prNumber: number,
  reviewResult: PRReviewResult | null,
  depthVerdictRow: ReturnType<typeof getDepthReviewVerdict> | undefined | null,
): string | null {
  const depthDimensions = depthVerdictRow
    ? (JSON.parse(depthVerdictRow.dimensions) as DepthReviewDimension[])
    : [];
  const failing = [
    ...(reviewResult?.dimensions ?? []).filter((d) => !d.passed),
    ...depthDimensions.filter((d) => !d.passed),
  ];
  if (failing.length === 0) return null;
  const lines = failing.map((d) => `❌ ${d.name}: ${d.notes}`).join('\n');
  const overall = [reviewResult?.summary, depthVerdictRow?.summary]
    .filter((s): s is string => Boolean(s))
    .join(' ');
  return `PR #${prNumber} review findings — please address the following:\n\n${lines}\n\nOverall: ${overall}`;
}
