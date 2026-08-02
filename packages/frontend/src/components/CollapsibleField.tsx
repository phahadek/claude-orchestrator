import { useCollapsibleText } from '../hooks/useCollapsibleText';
import styles from './CollapsibleField.module.css';

interface Props {
  text: string;
  'data-testid'?: string;
}

/**
 * Inline expand/collapse for a single proposal field — used for both
 * `decisionProposal`/`groomProposal` fields and expanded members' diff/
 * payload text. Renders fully with no toggle when under the threshold;
 * defaults to collapsed with a ▼/▲ toggle otherwise.
 */
export function CollapsibleField({ text, 'data-testid': dataTestId }: Props) {
  const { shouldCollapse, expanded, toggle, displayText, lineCount } =
    useCollapsibleText(text);

  return (
    <span data-testid={dataTestId}>
      <span className={styles.text}>{displayText}</span>
      {shouldCollapse && (
        <button type="button" className={styles.expandButton} onClick={toggle}>
          {expanded ? '▲ Collapse' : `▼ Show all ${lineCount} lines`}
        </button>
      )}
    </span>
  );
}
