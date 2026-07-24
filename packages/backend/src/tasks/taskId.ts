export type TaskSource = 'notion' | 'yaml' | 'jira' | 'github';

export interface ParsedTaskId {
  source: TaskSource;
  externalId: string;
}

const VALID_SOURCES = new Set<string>(['notion', 'yaml', 'jira', 'github']);

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

export function toExternalId(taskId: string): string {
  return parseTaskId(taskId).externalId;
}

/**
 * Idempotently normalize a task ID to `source:externalId` form. If `id` is
 * already a valid prefixed task ID, it is returned unchanged; otherwise it is
 * wrapped as `notion:<id>`. This lets Notion adapter methods accept both the
 * raw Notion UUIDs exposed by the groom-context bundle and already-prefixed
 * ids (e.g. from createTask) without double-prefixing the latter.
 */
export function normalizeTaskId(id: string): string {
  const colonIndex = id.indexOf(':');
  if (colonIndex >= 0) {
    const source = id.substring(0, colonIndex);
    if (VALID_SOURCES.has(source) && id.length > colonIndex + 1) {
      return id;
    }
  }
  return formatTaskId('notion', id);
}

/**
 * Normalize a task/board-row id for equality comparison, ignoring the
 * `source:` prefix (if present) and hyphen/case formatting. Board rows carry
 * bare external ids while dispatched task ids carry the `source:` prefix, so
 * comparing on this form lets the two line up.
 */
export function normalizeBoardId(id: string): string {
  const colonIndex = id.indexOf(':');
  const bare =
    colonIndex >= 0 && VALID_SOURCES.has(id.substring(0, colonIndex))
      ? id.substring(colonIndex + 1)
      : id;
  return bare.replace(/-/g, '').toLowerCase();
}
