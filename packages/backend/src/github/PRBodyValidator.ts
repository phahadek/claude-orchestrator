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

// "No test changes" or trivial equivalents ("none", "n/a") with nothing else
// are rejected unless followed by a substantive reason, mirroring groomGate's
// bare none/n/a gate_contribution rejection.
const BARE_NO_TEST_CHANGES_RE = /^no test changes\.?$|^(none|n\/a)\.?$/i;

/**
 * Extract the content of a "## <section>" heading up to the next "## " heading
 * (or end of body), trimmed.
 */
function extractSectionContent(body: string, section: string): string | null {
  const idx = body.indexOf(section);
  if (idx === -1) return null;
  const start = idx + section.length;
  const rest = body.slice(start);
  const nextHeadingIdx = rest.search(/\n##\s/);
  const content = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx);
  return content.trim();
}

/**
 * Validate that a PR body contains all required template sections.
 * Accepts "## Task Source" and "## Task" as alternatives to "## Notion Task"
 * for projects that use a different task backend.
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
      if (
        !body.includes('## Notion Task') &&
        !body.includes('## Task Source') &&
        !body.includes('## Task')
      ) {
        missingSections.push(section);
      }
    } else if (section === '## Automated Tests') {
      const content = extractSectionContent(body, section);
      if (content === null) {
        missingSections.push(section);
      } else if (BARE_NO_TEST_CHANGES_RE.test(content)) {
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
