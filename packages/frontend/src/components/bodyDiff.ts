/**
 * Per-section diff for a proposed task.updateBody against the task's stored
 * markdown body — the decision panel's headline for that intent kind,
 * replacing a raw JSON.stringify of the payload. Sections are split on the
 * same `## `/`### ` heading grammar renderTaskBodyMarkdown emits
 * (bodyRender.ts), so a stored Notion/GitHub/Jira body renders the same
 * section names as the proposed sections.
 */

interface DiffLine {
  kind: 'added' | 'removed' | 'unchanged';
  text: string;
}

export interface SectionDiff {
  name: string;
  changed: boolean;
  lines: DiffLine[];
}

function splitSections(markdown: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = 'Preamble';
  sections.set(current, []);
  for (const line of markdown.split('\n')) {
    const match = /^(#{2,3})\s+(.*)$/.exec(line);
    if (match) {
      current = match[2].trim();
      sections.set(current, []);
      continue;
    }
    sections.get(current)?.push(line);
  }
  return sections;
}

/** Longest-common-subsequence line diff — small inputs (task body sections), so O(n*m) is fine. */
function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        oldLines[i] === newLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ kind: 'unchanged', text: oldLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ kind: 'removed', text: oldLines[i] });
      i++;
    } else {
      result.push({ kind: 'added', text: newLines[j] });
      j++;
    }
  }
  while (i < n) result.push({ kind: 'removed', text: oldLines[i++] });
  while (j < m) result.push({ kind: 'added', text: newLines[j++] });
  return result;
}

/**
 * Diffs a proposed body (rendered from the staged sections) against the
 * task's stored markdown, one entry per section that appears on either side.
 * Sections with no changes are still returned (changed: false) so callers
 * can render an "unchanged" summary line instead of hiding the section.
 */
export function diffTaskBody(
  storedMarkdown: string,
  proposedMarkdown: string,
): SectionDiff[] {
  const stored = splitSections(storedMarkdown);
  const proposed = splitSections(proposedMarkdown);
  const names = [...new Set([...stored.keys(), ...proposed.keys()])].filter(
    (n) => n !== 'Preamble',
  );

  return names.map((name) => {
    const oldLines = (stored.get(name) ?? []).filter((l) => l.trim() !== '');
    const newLines = (proposed.get(name) ?? []).filter((l) => l.trim() !== '');
    const lines = diffLines(oldLines, newLines);
    const changed = lines.some((l) => l.kind !== 'unchanged');
    return { name, changed, lines };
  });
}
