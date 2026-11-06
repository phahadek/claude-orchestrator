import type { ProjectConfig } from '../config';

/**
 * The milestone AutoLauncher dispatches from for a project: the explicit
 * `autoLaunchMilestoneId` wins; otherwise the first milestone in display
 * order with a non-empty sourceId. Shared with the test lane so both rank
 * against the same board — `ProjectConfig.boardId` is the first milestone by
 * display order (typically a long-wrapped one), not the active milestone.
 */
export function resolveAutoLaunchMilestoneId(
  project: Pick<ProjectConfig, 'autoLaunchMilestoneId' | 'boards'>,
): string | null {
  if (project.autoLaunchMilestoneId) return project.autoLaunchMilestoneId;
  const firstWithSource = project.boards?.find((b) => b.sourceId);
  return firstWithSource?.id ?? null;
}
