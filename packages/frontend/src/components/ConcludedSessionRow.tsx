import { StatusBadge } from './StatusBadge';
import styles from './ConcludedSessionRow.module.css';

interface Props {
  taskName: string;
  status: string;
  elapsed?: string | null;
  endDate?: string | null;
  prUrl?: string | null;
  projectColor?: string;
  onClick: () => void;
}

export function ConcludedSessionRow({
  taskName,
  status,
  elapsed,
  endDate,
  prUrl,
  projectColor,
  onClick,
}: Props) {
  const borderStyle = projectColor
    ? { borderLeft: `3px solid ${projectColor}` }
    : undefined;

  return (
    <div
      className={styles.row}
      style={borderStyle}
      onClick={onClick}
      role="button"
      tabIndex={0}
      data-testid="concluded-session-row"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
    >
      <div className={styles.rowMain}>
        <span className={styles.taskName}>{taskName}</span>
        <StatusBadge status={status} />
      </div>
      <div className={styles.rowMeta}>
        {endDate && <span>{endDate}</span>}
        {elapsed && <span>{elapsed}</span>}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className={styles.prLink}
            onClick={(e) => e.stopPropagation()}
          >
            PR ↗
          </a>
        )}
        <span className={styles.expandHint} aria-hidden="true">
          ↗
        </span>
      </div>
    </div>
  );
}
