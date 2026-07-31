import { useCallback, useMemo, useState } from 'react';

/**
 * The default collapse threshold — generous enough that ordinary-length
 * proposal fields (a sentence or two) never show a toggle at all. Mirrors
 * the per-block expand/collapse idiom EventTranscript.tsx established for
 * long tool-result output.
 */
export const DEFAULT_COLLAPSE_LINES = 12;

export interface CollapsibleText {
  /** Whether the text exceeds the threshold and needs a toggle at all. */
  shouldCollapse: boolean;
  /** Local, ephemeral UI state — never persisted or WS-driven. */
  expanded: boolean;
  toggle: () => void;
  /** The text to render given the current expanded state. */
  displayText: string;
  lineCount: number;
}

/**
 * Inline expand/collapse for a single long text field — the same
 * useState-expanded-flag + shouldCollapse-guard shape EventTranscript.tsx's
 * ToolResultRow uses for tool output, generalized so proposal fields in the
 * decision panel can reuse it instead of a modal/drawer/detail view.
 */
export function useCollapsibleText(
  text: string | null | undefined,
  collapseLines: number = DEFAULT_COLLAPSE_LINES,
): CollapsibleText {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((e) => !e), []);

  const lines = useMemo(() => (text ?? '').split('\n'), [text]);
  const shouldCollapse = lines.length > collapseLines;
  const displayText =
    shouldCollapse && !expanded
      ? lines.slice(0, collapseLines).join('\n')
      : (text ?? '');

  return {
    shouldCollapse,
    expanded,
    toggle,
    displayText,
    lineCount: lines.length,
  };
}
