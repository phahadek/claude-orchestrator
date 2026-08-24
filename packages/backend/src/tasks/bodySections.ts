import type { PatchBodySectionOperation } from './TaskBackend';

/**
 * Heading-bounded range of a section within a flattened markdown body: the
 * heading line's index and the exclusive index of the next heading (or the
 * end of the body).
 */
interface MarkdownSectionRange {
  start: number;
  end: number;
}

/**
 * Locates the heading-bounded range of `section` in a flattened markdown
 * body. Case/whitespace-insensitive match on the heading text. Shared by
 * every caller that needs to address an arbitrary heading in a task body —
 * including headings with no dedicated field anywhere in TaskBodySections
 * (e.g. readinessGate.ts's live '## Open Questions' scan) — so a single
 * splitter stays the source of truth for "where does this section live".
 */
function findMarkdownSectionRange(
  lines: string[],
  section: string,
): MarkdownSectionRange | null {
  const target = section.trim().toLowerCase();
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^#{1,6}\s*(.+)$/);
    if (!heading) continue;
    if (start === -1) {
      if (heading[1].trim().toLowerCase() === target) start = i;
      continue;
    }
    end = i;
    break;
  }
  return start === -1 ? null : { start, end };
}

/**
 * Result of splicePatchBodySection: `applied: false` means the patch could
 * not be composed (target section missing, or find-text absent from it) —
 * `body` is the input unchanged and `reason` names why, for the caller to
 * either surface (staging-time preview) or fail on (apply-time write).
 */
export interface SplicePatchResult {
  body: string;
  applied: boolean;
  reason?: string;
}

/**
 * Splices a task.patchBodySection append/replace/remove operation into a
 * flattened markdown body at the target heading's boundaries. Pure/best
 * effort: never throws, always returns a result describing whether the
 * patch could be composed. Callers decide what to do with `applied: false`
 * — a staging-time preview surfaces it, while an apply-time write (e.g.
 * NotionClient.patchBodySection, LocalTaskBackend.patchBodySection) fails
 * explicitly for replace/append and treats it as a no-op for remove.
 */
export function splicePatchBodySection(
  storedBody: string,
  section: string,
  patch: PatchBodySectionOperation,
): SplicePatchResult {
  const lines = storedBody.split('\n');
  const range = findMarkdownSectionRange(lines, section);

  if (patch.operation === 'remove') {
    if (!range) {
      return {
        body: storedBody,
        applied: false,
        reason: `section "${section}" not found`,
      };
    }
    return {
      body: [...lines.slice(0, range.start), ...lines.slice(range.end)].join(
        '\n',
      ),
      applied: true,
    };
  }

  if (patch.operation === 'append') {
    if (!range) {
      return {
        body: [
          storedBody.trimEnd(),
          '',
          `## ${section}`,
          '',
          patch.content,
        ].join('\n'),
        applied: true,
      };
    }
    return {
      body: [
        ...lines.slice(0, range.end),
        patch.content,
        ...lines.slice(range.end),
      ].join('\n'),
      applied: true,
    };
  }

  // replace
  if (!range) {
    return {
      body: storedBody,
      applied: false,
      reason: `section "${section}" not found`,
    };
  }
  const sectionText = lines.slice(range.start + 1, range.end).join('\n');
  if (!sectionText.includes(patch.find)) {
    return {
      body: storedBody,
      applied: false,
      reason: `find text not present in section "${section}"`,
    };
  }
  const mutated = sectionText.replace(patch.find, patch.replaceWith);
  return {
    body: [
      ...lines.slice(0, range.start + 1),
      mutated,
      ...lines.slice(range.end),
    ].join('\n'),
    applied: true,
  };
}
