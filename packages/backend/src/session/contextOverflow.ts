/**
 * Returns true if the raw CLI result event represents a context-window overflow.
 *
 * Two overflow forms:
 *   1. stop_reason="model_context_window_exceeded"  (generation hit the limit, Claude 4.5+)
 *   2. is_error=true with result matching /prompt is too long/i  (input alone too big)
 *
 * This is a pure function — no side effects, independently testable. T3b consumes
 * the classified signal to decide on escalation.
 */
export function isContextOverflow(event: Record<string, unknown>): boolean {
  if (event.stop_reason === 'model_context_window_exceeded') return true;
  if (event.is_error === true) {
    const result = typeof event.result === 'string' ? event.result : '';
    if (/prompt is too long/i.test(result)) return true;
  }
  return false;
}
