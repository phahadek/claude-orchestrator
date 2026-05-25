import { useState, useMemo, useRef, useEffect } from 'react';
import type { TaskView } from '../types/taskView';
import { computeProgressFromTaskViews } from '../utils/computeWaves';
import { WaveView } from './WaveView';
import styles from './MilestoneProgress.module.css';

interface Props {
  tasks: TaskView[];
  compact?: boolean;
}

const STATUS_LABELS: { key: string; label: string; cls: string }[] = [
  { key: '✅ Done', label: '✅', cls: 'segDone' },
  { key: '👀 In Review', label: '👀', cls: 'segReview' },
  { key: '🔄 In Progress', label: '🔄', cls: 'segActive' },
  { key: '🗂️ Ready', label: '🗂️', cls: 'segOther' },
  { key: '🔲 Backlog', label: '🔲', cls: 'segOther' },
];

export function MilestoneProgress({ tasks, compact = false }: Props) {
  const [waveOpen, setWaveOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { waves, statusCounts, deferredCount, totalNonDeferred, doneCount } =
    useMemo(() => computeProgressFromTaskViews(tasks), [tasks]);

  // Close wave panel on outside click (desktop)
  useEffect(() => {
    if (!waveOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setWaveOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [waveOpen]);

  // Close popover on outside click or Escape (compact/mobile)
  useEffect(() => {
    if (!popoverOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setPopoverOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setPopoverOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [popoverOpen]);

  if (totalNonDeferred === 0) return null;

  const pct = (count: number) =>
    totalNonDeferred > 0 ? (count / totalNonDeferred) * 100 : 0;

  const segCounts = STATUS_LABELS.map((s) => ({
    ...s,
    count: statusCounts[s.key] ?? 0,
  }));
  const countedTotal = segCounts.reduce((acc, s) => acc + s.count, 0);
  const otherCount = Math.max(0, totalNonDeferred - countedTotal);

  const barSegments = (
    <>
      {segCounts.map((s) =>
        s.count > 0 ? (
          <div
            key={s.key}
            className={`${styles.barSegment} ${styles[s.cls as keyof typeof styles]}`}
            style={{ width: `${pct(s.count)}%` }}
          />
        ) : null,
      )}
      {otherCount > 0 && (
        <div
          className={`${styles.barSegment} ${styles.segOther}`}
          style={{ width: `${pct(otherCount)}%` }}
        />
      )}
    </>
  );

  const countChips = (
    <>
      {segCounts.map((s) =>
        s.count > 0 ? (
          <span key={s.key} className={styles.countItem} title={s.key}>
            {s.label} {s.count}
          </span>
        ) : null,
      )}
      {deferredCount > 0 && (
        <span className={styles.deferred} title="Deferred">
          ⏭️ {deferredCount}
        </span>
      )}
    </>
  );

  if (compact) {
    return (
      <div className={styles.compactWrapper} ref={wrapperRef}>
        <button
          type="button"
          className={styles.compactButton}
          onClick={() => setPopoverOpen((v) => !v)}
          title={`${doneCount}/${totalNonDeferred} tasks done — tap to see breakdown`}
          aria-expanded={popoverOpen}
          aria-label="Toggle milestone breakdown"
          data-testid="compact-milestone-progress"
        >
          <div className={styles.compactBar}>{barSegments}</div>
          <span className={styles.compactLabel}>
            {doneCount}/{totalNonDeferred}
          </span>
        </button>

        {popoverOpen && (
          <div
            className={styles.popover}
            role="dialog"
            aria-label="Milestone breakdown"
            data-testid="milestone-popover"
          >
            <div className={styles.popoverCounts}>{countChips}</div>
            <WaveView waves={waves} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        type="button"
        className={styles.barButton}
        onClick={() => setWaveOpen((v) => !v)}
        title={`${doneCount}/${totalNonDeferred} tasks done — click to view waves`}
        aria-expanded={waveOpen}
        aria-label="Toggle wave view"
      >
        <div className={styles.bar}>{barSegments}</div>
        <span className={styles.label}>
          {doneCount}/{totalNonDeferred}
        </span>
      </button>

      <div className={styles.counts}>{countChips}</div>

      {waveOpen && <WaveView waves={waves} />}
    </div>
  );
}
