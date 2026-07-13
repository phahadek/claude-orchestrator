import {
  recordProjectDeployedSha,
  getProjectDeployedShaRow,
} from '../db/queries';

/**
 * The orchestrator owns the live deployed-commit record — reported in by
 * each project's deploy flow (skill→orchestrator direction), never read
 * from a deploy-written file.
 */
export function reportProjectDeploy(projectId: string, sha: string): void {
  recordProjectDeployedSha(projectId, sha);
}

/** The project's last-reported deployed SHA, or null if never reported. */
export function getProjectDeployedSha(projectId: string): string | null {
  return getProjectDeployedShaRow(projectId)?.sha ?? null;
}
