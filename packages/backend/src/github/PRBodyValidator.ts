export interface PRBodyValidationResult {
  valid: boolean;
  missingSections: string[];
}

const REQUIRED_SECTIONS = [
  '## Summary',
  '## Notion Task',
  '## Automated Tests',
  '## Files Changed',
] as const;

/**
 * Validate that a PR body contains all required template sections.
 * Accepts "## Task Source" as an alternative to "## Notion Task" for
 * projects that use a different task backend.
 */
export function validatePRBody(
  body: string | null | undefined,
): PRBodyValidationResult {
  if (!body || body.trim() === '') {
    return { valid: false, missingSections: [...REQUIRED_SECTIONS] };
  }

  const missingSections: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    if (section === '## Notion Task') {
      if (!body.includes('## Notion Task') && !body.includes('## Task Source')) {
        missingSections.push(section);
      }
    } else if (!body.includes(section)) {
      missingSections.push(section);
    }
  }

  return { valid: missingSections.length === 0, missingSections };
}

/**
 * Build a GitHub PR comment listing missing sections.
 * Used when corporate mode blocks a non-conforming PR.
 */
export function buildValidationComment(missingSections: string[]): string {
  const list = missingSections.map((s) => `- \`${s}\``).join('\n');
  return (
    '**PR body validation failed.** The following required sections are missing:\n\n' +
    list +
    '\n\nPlease update the PR body to include all required sections before this PR can proceed.'
  );
}
