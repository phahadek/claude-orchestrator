import type { StageId, StageInfo } from '../utils/stageSelection';
import styles from './StageBar.module.css';

const STATUS_ICON: Record<StageInfo['status'], string> = {
  not_started: '·',
  active: '●',
  waiting: '●',
  done: '✓',
  error: '!',
};

const STATUS_CSS_KEYS: Record<StageInfo['status'], string> = {
  not_started: 'status--not-started',
  active: 'status--active',
  waiting: 'status--waiting',
  done: 'status--done',
  error: 'status--error',
};

interface Props {
  stages: StageInfo[];
  selected: StageId;
  onSelect: (stage: StageId) => void;
}

export function StageBar({ stages, selected, onSelect }: Props) {
  return (
    <div className={styles.bar} role="tablist" aria-label="Task stages">
      {stages.map((stage) => {
        const isSelected = stage.id === selected;
        return (
          <button
            key={stage.id}
            type="button"
            role="tab"
            aria-selected={isSelected}
            className={`${styles.chip} ${isSelected ? styles.chipSelected : ''}`}
            data-testid={`stage-chip-${stage.id}`}
            onClick={() => onSelect(stage.id)}
          >
            <span
              className={`${styles.statusDot} ${styles[STATUS_CSS_KEYS[stage.status]]}`}
              aria-hidden="true"
            >
              {STATUS_ICON[stage.status]}
            </span>
            <span className={styles.chipLabel}>{stage.label}</span>
            {stage.demand && (
              <span
                className={styles.demandBadge}
                data-testid={`stage-demand-${stage.id}`}
                aria-label={`${stage.label} needs your attention`}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
