/**
 * Detects a project's declared worker-crash signature (OrchestratorConfig.
 * test_crash_signatures — plain substrings, not regexes) in a timed-out test
 * run's output, and renders the size-capped message that gets routed to the
 * session in place of raw/tail output — crash output can be very large and
 * has blown session context before, so this never forwards more than the
 * lines that actually matched plus the crashed test's node id.
 */

const MAX_MESSAGE_CHARS = 2000;

/** pytest-xdist's own wording when a worker dies mid-test, e.g. `[gw3] node down: Not properly terminated` followed by `worker gw3 crashed while running 'tests/foo.py::test_bar'`. */
const NODE_ID_PATTERN = /crashed while running '([^']+)'/;

export interface CrashSignatureMatch {
  /** Every output line containing at least one configured signature substring, in original order. */
  matchedLines: string[];
  /** The crashed test's node id, when the output names one. */
  nodeId?: string;
}

/**
 * Returns null when `signatures` is empty or none matched — the caller's own
 * "unset/empty config → unchanged behavior" fallback.
 */
export function detectCrashSignature(
  output: string,
  signatures: string[],
): CrashSignatureMatch | null {
  if (signatures.length === 0) return null;
  const matchedLines = output
    .split('\n')
    .filter((line) => signatures.some((sig) => line.includes(sig)));
  if (matchedLines.length === 0) return null;
  const nodeId = output.match(NODE_ID_PATTERN)?.[1];
  return nodeId ? { matchedLines, nodeId } : { matchedLines };
}

/**
 * Renders the capped session message for a confirmed worker-crash match —
 * never the raw or tail-truncated run output, only the matched lines/node id
 * this module itself extracted.
 */
export function buildWorkerCrashMessage(match: CrashSignatureMatch): string {
  const lines = [
    '## Test Worker Crash',
    '',
    'This test run timed out because a test worker crashed — not because it hung. Re-running the unchanged tree will not help; the crash itself must be fixed.',
    '',
    ...(match.nodeId ? [`**Crashed test:** \`${match.nodeId}\``, ''] : []),
    '**Matched signature lines:**',
    '```',
    match.matchedLines.join('\n'),
    '```',
  ];
  const message = lines.join('\n');
  return message.length > MAX_MESSAGE_CHARS
    ? message.slice(0, MAX_MESSAGE_CHARS)
    : message;
}
