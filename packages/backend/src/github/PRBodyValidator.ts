export interface PRBodyValidationResult {
  valid: boolean;
  missingSections: string[];
  /** Sections present but whose content exceeds the configured per-section char limit. Absent on results predating this field — treat as empty. */
  oversizedSections?: string[];
}

/**
 * The section set required when a project declares no `pr_body` block in its
 * `.claude-orchestrator.yml` — see OrchestratorConfig.pr_body in
 * session/orchestrator-config.ts. `## Files Changed` is intentionally absent:
 * it duplicates GitHub's own Files-changed tab and is now opt-in only (a
 * project adds it back by listing it explicitly in `pr_body.sections`).
 */
export const DEFAULT_PR_BODY_SECTIONS = [
  '## Summary',
  '## Notion Task',
  '## Automated Tests',
] as const;

export interface PrBodySectionsConfig {
  sections: readonly string[];
  maxSectionChars?: Record<string, number>;
}

// "No test changes" or trivial equivalents ("none", "n/a") with nothing else
// are rejected unless followed by a substantive reason, mirroring groomGate's
// bare none/n/a gate_contribution rejection.
const BARE_NO_TEST_CHANGES_RE = /^no test changes\.?$|^(none|n\/a)\.?$/i;

/**
 * Returns the trimmed content of `section` (the text between its own header
 * and the next `## ` header, or end of body). Empty string if the section
 * header isn't present.
 */
function extractSectionContent(body: string, section: string): string {
  const start = body.indexOf(section);
  if (start === -1) return '';
  const afterHeader = start + section.length;
  const nextHeaderMatch = body.slice(afterHeader).match(/\n## /);
  const end = nextHeaderMatch
    ? afterHeader + (nextHeaderMatch.index ?? 0)
    : body.length;
  return body.slice(afterHeader, end).trim();
}

/**
 * Validate that a PR body contains all required template sections, and that
 * none of them exceed their configured length ceiling.
 *
 * Accepts "## Task Source" and "## Task" as alternatives to "## Notion Task"
 * for projects that use a different task backend. `config` defaults to
 * DEFAULT_PR_BODY_SECTIONS with no length ceilings — the behavior a project
 * with no `pr_body` block in `.claude-orchestrator.yml` gets.
 */
export function validatePRBody(
  body: string | null | undefined,
  config: PrBodySectionsConfig = { sections: DEFAULT_PR_BODY_SECTIONS },
): PRBodyValidationResult {
  const sections = config.sections;
  if (!body || body.trim() === '') {
    return { valid: false, missingSections: [...sections], oversizedSections: [] };
  }

  const missingSections: string[] = [];
  for (const section of sections) {
    if (section === '## Notion Task') {
      if (
        !body.includes('## Notion Task') &&
        !body.includes('## Task Source') &&
        !body.includes('## Task')
      ) {
        missingSections.push(section);
      }
    } else if (section === '## Automated Tests') {
      if (!body.includes(section)) {
        missingSections.push(section);
      } else if (BARE_NO_TEST_CHANGES_RE.test(extractSectionContent(body, section))) {
        missingSections.push(section);
      }
    } else if (!body.includes(section)) {
      missingSections.push(section);
    }
  }

  const oversizedSections: string[] = [];
  if (config.maxSectionChars) {
    for (const [section, limit] of Object.entries(config.maxSectionChars)) {
      if (missingSections.includes(section)) continue;
      if (!sections.includes(section)) continue;
      const content = extractSectionContent(body, section);
      if (content.length > limit) {
        oversizedSections.push(section);
      }
    }
  }

  return {
    valid: missingSections.length === 0 && oversizedSections.length === 0,
    missingSections,
    oversizedSections,
  };
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
