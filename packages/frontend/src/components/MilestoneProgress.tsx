import { useState, useMemo, useRef, useEffect } from "react";
import type { TaskView } from "../types/taskView";
import { computeProgressFromTaskViews } from "../utils/computeWaves";
import { WaveView } from "./WaveView";
import styles from "./MilestoneProgress.module.css";

interface Props {
  tasks: TaskView[];
}

const STATUS_LABELS: { key: string; label: string; cls: string }[] = [
  { key: "✅ Done", label: "✅", cls: "segDone" },
  { key: "👀 In Review", label: "👀", cls: "segReview" },
  { key: "🔄 In Progress", label: "🔄", cls: "segActive" },
  { key: "🗂️ Ready", label: "🗂️", cls: "segOther" },
  { key: "🔲 Backlog", label: "🔲", cls: "segOther" },
];

export function MilestoneProgress({ tasks }: Props) {
  const [waveOpen, setWaveOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { waves, statusCounts, deferredCount, totalNonDeferred, doneCount } =
    useMemo(() => computeProgressFromTaskViews(tasks), [tasks]);

  // Close wave panel when clicking outside
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
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [waveOpen]);

  if (totalNonDeferred === 0) return null;

  const pct = (count: number) =>
    totalNonDeferred > 0 ? (count / totalNonDeferred) * 100 : 0;

  // Compute bar segments — clamp so they sum to 100%
  const segCounts = STATUS_LABELS.map((s) => ({
    ...s,
    count: statusCounts[s.key] ?? 0,
  }));
  const countedTotal = segCounts.reduce((acc, s) => acc + s.count, 0);
  // Remaining = statuses not in our list (shouldn't happen, but be safe)
  const otherCount = Math.max(0, totalNonDeferred - countedTotal);

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
        <div className={styles.bar}>
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
        </div>
        <span className={styles.label}>
          {doneCount}/{totalNonDeferred}
        </span>
      </button>

      <div className={styles.counts}>
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
      </div>

      {waveOpen && <WaveView waves={waves} />}
    </div>
  );
}
