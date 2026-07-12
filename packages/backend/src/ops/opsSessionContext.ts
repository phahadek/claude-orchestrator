/**
 * Backend-injected ops context for an individually-launched ops session
 * (Ops(N) button). Mirrors the code-dispatch backend-injection model: the
 * session never runs the vendored /ops remote-control skill, it just
 * receives the same context that skill used to assemble — the fixed master
 * context page(s) + this task's classification from loadOpsContext, plus its
 * existing ops_journal entry (worked history / staged disposition so far).
 */
import type { OpsLoadResult, OpsTaskEntry } from './opsLoad';
import { getEntry } from './opsJournal';

/** Render loadOpsContext + this task's ops_journal entry as session-injected markdown. */
export function buildOpsSessionContext(
  opsLoadResult: OpsLoadResult,
  task: OpsTaskEntry,
): string {
  const sections: string[] = [
    '## Ops Context',
    '',
    `This is an individual, human-launched ops session for a ${task.mode === 'investigation' ? '🔎 Investigation' : '🔧 Operational'} task. ` +
      'It is not auto-dispatched — a human selected it via the Ops(N) button.',
  ];

  for (const page of opsLoadResult.contextPages) {
    sections.push('', `### ${page.title}`, '', page.markdown);
  }

  sections.push(
    '',
    '### Task classification',
    '',
    `- Type: ${task.type}`,
    `- Mode: ${task.mode}`,
    `- Depends On: ${task.dependsOn.length > 0 ? task.dependsOn.join(', ') : '(none)'}`,
  );

  const journalEntry = getEntry(task.id);
  if (journalEntry) {
    sections.push(
      '',
      '### Existing ops_journal entry',
      '',
      '```json',
      JSON.stringify(journalEntry, null, 2),
      '```',
    );
  }

  return sections.join('\n');
}
