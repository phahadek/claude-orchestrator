import type { TaskView } from '../types/taskView';
import styles from './WaveView.module.css';

const STATUS_ICON: Record<string, string> = {
  '✅ Done': '✅',
  '👀 In Review': '👀',
  '🔄 In Progress': '🔄',
  '🗂️ Ready': '🗂️',
  '🔲 Backlog': '🔲',
};

interface Props {
  waves: TaskView[][];
}

export function WaveView({ waves }: Props) {
  if (waves.length === 0) return null;

  return (
    <div className={styles.container}>
      {waves.map((wave, i) => {
        const doneInWave = wave.filter(
          (t) => t.notionStatus === '✅ Done',
        ).length;
        const fillPct = wave.length > 0 ? (doneInWave / wave.length) * 100 : 0;
        const allDone = doneInWave === wave.length;

        return (
          <div key={i} className={styles.wave}>
            <div className={styles.waveHeader}>
              <span className={styles.waveLabel}>
                Wave {i + 1} ({wave.length})
              </span>
              <div
                className={styles.waveBar}
                title={`${doneInWave}/${wave.length} done`}
              >
                <div
                  className={`${styles.waveBarFill}${!allDone && fillPct > 0 ? ` ${styles.waveBarPartial}` : ''}`}
                  style={{ width: `${fillPct}%` }}
                />
              </div>
            </div>
            <div className={styles.taskList}>
              {wave.map((t) => {
                const icon = STATUS_ICON[t.notionStatus] ?? '•';
                const isDone = t.notionStatus === '✅ Done';
                return (
                  <div key={t.taskId} className={styles.taskRow}>
                    <span className={styles.taskStatus}>{icon}</span>
                    <span
                      className={`${styles.taskTitle}${isDone ? ` ${styles.done}` : ''}`}
                    >
                      {t.taskName}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
