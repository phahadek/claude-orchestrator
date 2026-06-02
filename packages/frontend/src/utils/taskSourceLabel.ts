import type { TaskSource } from '@claude-orchestrator/backend/src/db/types';

const LINK_LABELS: Record<TaskSource, string> = {
  notion: 'Notion ↗',
  github: 'Issue ↗',
  yaml: 'YAML',
  jira: 'Jira ↗',
};

const SHORT_LABELS: Record<TaskSource, string> = {
  notion: 'Notion',
  github: 'GitHub',
  yaml: 'YAML',
  jira: 'Jira',
};

export function getTaskSourceLinkLabel(source: TaskSource): string {
  return LINK_LABELS[source] ?? 'Notion ↗';
}

export function getTaskSourceShortLabel(source: TaskSource): string {
  return SHORT_LABELS[source] ?? 'Notion';
}
