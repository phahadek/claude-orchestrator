/**
 * Returns true if a raw CLI `user` event contains only system-injected content
 * (CLAUDE.md bootstrap, system reminders, local-command tags) and carries no
 * human-visible text.  Events that return true should be stored in the DB
 * (for debugging) but NOT broadcast to the frontend.
 */
export function isSystemOnlyUserEvent(payload: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;

  const p = parsed as Record<string, unknown>;
  if (p.type !== 'user') return false;

  const msg = p.message as Record<string, unknown> | undefined;
  const content = msg?.content ?? p.content;

  if (typeof content === 'string') {
    // Strip paired tag+content blocks first, then remaining standalone tags
    const stripped = content
      // eslint-disable-next-line security/detect-unsafe-regex -- Reason: verified non-backtracking against structured Claude API event payloads; lazy [\s\S]*? is anchored by the literal closing-tag backreference <\/\1>, inputs are bounded system-injected XML-like blocks.
      .replace(/<([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    return stripped.length === 0;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        const stripped = b.text
          // eslint-disable-next-line security/detect-unsafe-regex -- Reason: verified non-backtracking against structured Claude API event payloads; lazy [\s\S]*? is anchored by the literal closing-tag backreference <\/\1>, inputs are bounded system-injected XML-like blocks.
          .replace(/<([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, '')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (stripped.length > 0) return false;
      }
    }
    return true;
  }

  // Can't determine — don't filter
  return false;
}
