import { formatTaskId } from './taskId';

/**
 * Extracts a Notion page id from a task URL, either a 32-hex dashless id or a
 * 36-char dashed UUID at the end of the URL. Falls back to the raw url when
 * neither pattern matches.
 */
export function parseNotionPageId(url: string): string {
  const match = url.match(/([a-f0-9]{32})$/i);
  if (match) return match[1];
  const uuidMatch = url.match(/([0-9a-f-]{36})$/i);
  if (uuidMatch) return uuidMatch[1].replace(/-/g, '');
  return url;
}

/**
 * Like parseNotionPageId, but always returns the dashed UUID form (Notion's native).
 * Converts a 32-hex dashless ID to dashed; passes through already-dashed or non-UUID inputs unchanged.
 */
export function parseNotionPageIdDashed(url: string): string {
  const raw = parseNotionPageId(url);
  if (/^[0-9a-f]{32}$/i.test(raw)) {
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  }
  return raw;
}

/**
 * Derive a prefixed task ID from a task URL, using the project's task source
 * to determine the format.
 * - notion: formatTaskId('notion', parseNotionPageIdDashed(url)) — existing logic
 * - github: extracts issue number from https://github.com/.../issues/<N>
 * - other sources: fall back to notion parsing (safe for YAML/Jira which pass
 *   explicit taskId via StartOptions.taskId anyway)
 *
 * Kept in its own leaf module (no imports besides tasks/taskId), deliberately
 * duplicating SessionManager.ts's identically-named deriveTaskId, so callers
 * that only need id derivation — e.g. AutoLauncher's branch-existence guard —
 * can hash the same prefixed id that session creation hashes without pulling
 * in SessionManager.ts's/AgentSession.ts's full dependency graph (many tests
 * mock AgentSession's exports directly, which a shared import would upset).
 */
export function deriveTaskId(taskSource: string, taskUrl: string): string {
  if (taskSource === 'github') {
    const m = taskUrl.match(/\/issues\/(\d+)/);
    if (m) return formatTaskId('github', m[1]);
    // URL not parseable — store the raw URL under github prefix so lookups still work
    return formatTaskId('github', taskUrl);
  }
  return formatTaskId('notion', parseNotionPageIdDashed(taskUrl));
}
