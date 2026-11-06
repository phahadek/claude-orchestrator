import type { TaskView } from '../types/taskView';

const HIDDEN_NOTION_STATUSES = ['🔲 Backlog', '✅ Done', '⏭️ Deferred'];
const HIDDEN_DISPLAY_STATUSES = ['backlog', 'done', 'deferred'];

export function isUrgentToggleVisible(task: TaskView): boolean {
  if (!task.taskType.includes('💻')) return false;
  if (HIDDEN_DISPLAY_STATUSES.includes(task.displayStatus)) return false;
  if (HIDDEN_NOTION_STATUSES.includes(task.notionStatus)) return false;
  return true;
}

export function isEffectivelyUrgent(task: TaskView): boolean {
  return Boolean(task.urgent || task.executionRank?.urgentInherited);
}
