/**
 * Secret patterns to redact. Pattern-only matching — no entropy heuristic.
 * Patterns: sk-ant-* (Anthropic), gh[poursi]_* (GitHub PATs), secret_* (generic),
 * ntn_* (Notion), xox[bpars]-* (Slack).
 */
const SECRET_PATTERN =
  /\b(sk-ant-[A-Za-z0-9_-]{10,}|gh[poursi]_[A-Za-z0-9_-]{10,}|secret_[A-Za-z0-9_-]{10,}|ntn_[A-Za-z0-9_-]{10,}|xox[bpars]-[A-Za-z0-9-]+)\b/g;

/**
 * Matches Authorization: Bearer <token> (case-insensitive). Captures the token
 * as group 1 so it can be replaced regardless of shape or length.
 */
const BEARER_PATTERN = /\bBearer\s+(\S+)/gi;

const REDACTED = '[REDACTED]';

/**
 * Recursively traverse any JSON-serializable value and return a copy with
 * known secret patterns replaced. Primitives other than strings are returned
 * as-is. Cycles are not handled — callers must not pass circular references.
 */
export function scrubSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(
        BEARER_PATTERN,
        (match) => `${match.split(/\s+/)[0]} ${REDACTED}`,
      )
      .replace(SECRET_PATTERN, REDACTED) as T;
  }
  if (Array.isArray(value)) {
    return value.map(scrubSecrets) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = scrubSecrets(v);
    }
    return result as T;
  }
  return value;
}
