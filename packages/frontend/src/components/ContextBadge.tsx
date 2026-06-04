import styles from './ContextBadge.module.css';

function contextWindowForModel(model: string | null | undefined): number {
  return model?.includes('[1m]') ? 1_000_000 : 200_000;
}

interface Props {
  contextOccupancyTokens: number | undefined;
  compactionCount: number | undefined;
  model?: string | null;
}

export function ContextBadge({
  contextOccupancyTokens,
  compactionCount,
  model,
}: Props) {
  const contextWindow = contextWindowForModel(model);
  const ctxPct =
    contextOccupancyTokens != null
      ? Math.round((contextOccupancyTokens / contextWindow) * 100)
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
          title={`${(contextOccupancyTokens ?? 0).toLocaleString()} of ${contextWindow.toLocaleString()} tokens`}
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
