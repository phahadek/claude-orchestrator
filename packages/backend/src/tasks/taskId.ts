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
 * Canonicalize a bare external id's hyphenation so a Notion UUID resolves to
 * the same cache key whether it arrives hyphenated or not. Only touches
 * 32-hex-char ids (with or without hyphens already in place); anything else
 * (Jira keys, yaml slugs) passes through unchanged.
 */
function canonicalizeExternalId(externalId: string): string {
  const stripped = externalId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(stripped)) {
    return externalId;
  }
  return [
    stripped.slice(0, 8),
    stripped.slice(8, 12),
    stripped.slice(12, 16),
    stripped.slice(16, 20),
    stripped.slice(20),
  ].join('-');
}

/**
 * Idempotently normalize a task ID to `source:externalId` form. If `id` is
 * already a valid prefixed task ID, its source prefix is kept; otherwise it
 * is wrapped as `notion:<id>`. Either way, the external id's hyphenation is
 * canonicalized (see `canonicalizeExternalId`) so hyphenated and hyphenless
 * forms of the same Notion UUID resolve to one task_cache key. This lets
 * Notion adapter methods accept both the raw Notion UUIDs exposed by the
 * groom-context bundle and already-prefixed ids (e.g. from createTask)
 * without double-prefixing the latter.
 */
export function normalizeTaskId(id: string): string {
  const colonIndex = id.indexOf(':');
  if (colonIndex >= 0) {
    const source = id.substring(0, colonIndex);
    if (VALID_SOURCES.has(source) && id.length > colonIndex + 1) {
      const externalId = id.substring(colonIndex + 1);
      return formatTaskId(source as TaskSource, canonicalizeExternalId(externalId));
    }
  }
  return formatTaskId('notion', canonicalizeExternalId(id));
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
