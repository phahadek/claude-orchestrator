import {
  FLOOR_DETAILS_UNAVAILABLE,
  FLOOR_HEADLINE,
  FLOOR_IN_PROGRESS_COPY,
  FLOOR_READY_COPY,
  type FloorSignOff,
} from '../utils/floorSignOff';
import styles from './FloorSignOffDetail.module.css';

interface Props {
  floor: FloorSignOff;
  /** Label lookup for the other blocking pause entries; falls back to the raw reason. */
  reasonLabels?: Record<string, string>;
  showHeadline?: boolean;
}

export function FloorSignOffDetail({
  floor,
  reasonLabels,
  showHeadline = true,
}: Props) {
  return (
    <div
      className={styles.floorSignOff}
      data-floor-ready={floor.ready ? 'true' : 'false'}
    >
      {showHeadline && <div className={styles.headline}>{FLOOR_HEADLINE}</div>}
      <div className={styles.matched}>
        {floor.categories
          ? `Touches ${floor.categories}${floor.paths ? `: ${floor.paths}` : ''}`
          : FLOOR_DETAILS_UNAVAILABLE}
      </div>
      <div className={styles.readiness}>
        {floor.ready ? (
          FLOOR_READY_COPY
        ) : (
          <>
            {FLOOR_IN_PROGRESS_COPY} —{' '}
            {floor.otherBlockingReasons
              .map((r) => reasonLabels?.[r] ?? r)
              .join('; ')}
          </>
        )}
      </div>
    </div>
  );
}
