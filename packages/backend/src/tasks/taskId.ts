export type TaskSource = 'notion' | 'yaml' | 'jira';

export interface ParsedTaskId {
  source: TaskSource;
  externalId: string;
}

const VALID_SOURCES = new Set<string>(['notion', 'yaml', 'jira']);

export function parseTaskId(taskId: string): ParsedTaskId {
  const colonIndex = taskId.indexOf(':');
  if (colonIndex < 0) {
    throw new Error(`Invalid task ID (no colon): ${taskId}`);
  }
  const source = taskId.substring(0, colonIndex);
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`Unknown task source "${source}" in task ID: ${taskId}`);
  }
  const externalId = taskId.substring(colonIndex + 1);
  if (!externalId) {
    throw new Error(`Invalid task ID (empty external ID): ${taskId}`);
  }
  return { source: source as TaskSource, externalId };
}

export function formatTaskId(source: TaskSource, externalId: string): string {
  return `${source}:${externalId}`;
}
