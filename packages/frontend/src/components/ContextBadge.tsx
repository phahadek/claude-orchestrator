import styles from './ContextBadge.module.css';

const CONTEXT_WINDOW = 200_000;

interface Props {
  contextOccupancyTokens: number | undefined;
  compactionCount: number | undefined;
}

export function ContextBadge({ contextOccupancyTokens, compactionCount }: Props) {
  const ctxPct =
    contextOccupancyTokens != null
      ? Math.round((contextOccupancyTokens / CONTEXT_WINDOW) * 100)
      : null;

  return (
    <>
      {(compactionCount ?? 0) > 0 && (
        <span className={styles.compactionBadge}>
          compacted {compactionCount}×
        </span>
      )}
      {ctxPct != null && (
        <span
          className={styles.contextBadge}
          title={`${(contextOccupancyTokens ?? 0).toLocaleString()} of ${CONTEXT_WINDOW.toLocaleString()} tokens`}
        >
          <span
            className={styles.contextBarFill}
            style={{ width: `${Math.min(ctxPct, 100)}%` }}
            aria-hidden="true"
          />
          <span className={styles.contextText}>{ctxPct}% ctx</span>
        </span>
      )}
    </>
  );
}
