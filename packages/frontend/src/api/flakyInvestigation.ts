import { apiRequest } from './projects';

/** POST /api/milestones/:project/flaky-investigation — files one operator-driven
 * 🔎 Investigation task covering an operator-selected group of currently
 * flagged-flaky tests. See backend/src/audit/flakyRemediationFiling.ts. */
export function fileFlakyInvestigation(
  projectId: string,
  milestoneId: string,
  testIds: string[],
): Promise<{ taskId: string }> {
  return apiRequest<{ taskId: string }>(
    `/api/milestones/${encodeURIComponent(projectId)}/flaky-investigation`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testIds, milestoneId }),
    },
  );
}
