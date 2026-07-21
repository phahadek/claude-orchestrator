const VALID_SOURCES = new Set(['notion', 'yaml', 'jira', 'github']);

/**
 * Strips a leading `source:` prefix from a task ref (e.g. `notion:<uuid>` ->
 * `<uuid>`), mirroring the backend's bareId / toExternalId. Bare ids pass
 * through unchanged. Lets launch reconciliation compare frontend task refs
 * against the bare ids the launcher and ops_journal use.
 */
export function bareTaskId(id: string): string {
  const colonIndex = id.indexOf(':');
  if (colonIndex < 0) return id;
  const source = id.substring(0, colonIndex);
  if (!VALID_SOURCES.has(source)) return id;
  return id.substring(colonIndex + 1);
}
