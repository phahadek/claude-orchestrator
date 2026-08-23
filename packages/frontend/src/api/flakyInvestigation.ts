import { authedFetch } from './projects';

/** Mirrors FlakyInvestigationFilingError's `reason` union in
 * backend/src/audit/flakyRemediationFiling.ts — undefined for errors that
 * never reached the filing service (network failure, non-JSON body, etc). */
export type FlakyInvestigationErrorReason =
  | 'no-test-ids'
  | 'not-flagged-flaky'
  | 'already-open'
  | 'claim-conflict'
  | 'unknown-milestone'
  | 'backend-unsupported'
  | undefined;

export class FlakyInvestigationError extends Error {
  constructor(
    message: string,
    public readonly reason: FlakyInvestigationErrorReason,
  ) {
    super(message);
    this.name = 'FlakyInvestigationError';
  }
}

/** POST /api/milestones/:project/flaky-investigation — files one operator-driven
 * 🔎 Investigation task covering an operator-selected group of currently
 * flagged-flaky tests. See backend/src/audit/flakyRemediationFiling.ts.
 * Preserves the response's `reason` field (unlike the generic apiRequest
 * helper) so callers can distinguish a batch-reject — e.g. a test in the
 * selection was claimed by a concurrent filing — from a generic failure. */
export async function fileFlakyInvestigation(
  projectId: string,
  milestoneId: string,
  testIds: string[],
): Promise<{ taskId: string }> {
  const res = await authedFetch(
    `/api/milestones/${encodeURIComponent(projectId)}/flaky-investigation`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testIds, milestoneId }),
    },
  );

  if (res.status === 401) {
    throw new FlakyInvestigationError('Unauthorized', undefined);
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let reason: FlakyInvestigationErrorReason;
    try {
      const body = (await res.json()) as {
        error?: string;
        reason?: FlakyInvestigationErrorReason;
      };
      if (body?.error) message = body.error;
      reason = body?.reason;
    } catch {
      /* body is not JSON */
    }
    throw new FlakyInvestigationError(message, reason);
  }

  return (await res.json()) as { taskId: string };
}
