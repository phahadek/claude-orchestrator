/**
 * Failure-message signature used by breadth excusal: two failures of the same
 * test_id are "the same failure" only when their messages match after
 * stripping tokens that vary run to run. Asserted literals (including small
 * integers such as `[183]` vs `[184]`) are deliberately kept.
 */

const VOLATILE_TOKEN_RULES: Array<[RegExp, string]> = [
  [
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    '<ts>',
  ],
  [/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>'],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    '<uuid>',
  ],
  [/\b0x[0-9a-f]{6,}\b/gi, '<addr>'],
  [
    /(?<![\w.])[A-Za-z]:\\(?:[^\s\\'"`()<>[\]]+\\)*[^\s\\'"`()<>[\]]*/g,
    '<path>',
  ],
  [/(?<![\w.:/])\/(?:[\w.@~+=-]+\/)+[\w.@~+=-]*/g, '<path>'],
  [/(\.[A-Za-z]{1,5}):\d+(?::\d+)?/g, '$1:<loc>'],
  [/\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|seconds?|secs?|s)\b/g, '<dur>'],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/gi, '<hash>'],
];

export function normalizeFailureMessage(message: string): string {
  let out = message;
  for (const [re, replacement] of VOLATILE_TOKEN_RULES) {
    out = out.replace(re, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** A message-less failure is one with a null, empty or whitespace-only message. */
export function hasFailureMessage(
  message: string | null | undefined,
): message is string {
  return typeof message === 'string' && message.trim() !== '';
}
