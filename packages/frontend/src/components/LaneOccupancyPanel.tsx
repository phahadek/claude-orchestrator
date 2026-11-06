import type {
  LaneOccupancyBucket,
  LaneOccupancyLane,
} from '../hooks/useProjectTestHealth';
import styles from './TestsHealthTab.module.css';

const DAY_MS = 24 * 60 * 60 * 1000;

interface DayPoint {
  day: string;
  peakRunning: number;
  peakQueued: number;
}

function toDays(buckets: LaneOccupancyBucket[]): DayPoint[] {
  const byDay = new Map<string, DayPoint>();
  for (const b of buckets) {
    const day = new Date(Math.floor(b.t / DAY_MS) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const point = byDay.get(day) ?? { day, peakRunning: 0, peakQueued: 0 };
    point.peakRunning = Math.max(point.peakRunning, b.peakRunning);
    point.peakQueued = Math.max(point.peakQueued, b.peakQueued);
    byDay.set(day, point);
  }
  return [...byDay.values()];
}

function LaneChart({ lane }: { lane: LaneOccupancyLane }) {
  const days = toDays(lane.buckets);
  const max = Math.max(
    1,
    lane.capacity,
    ...days.map((d) => d.peakRunning + d.peakQueued),
  );
  const idle = days.every((d) => d.peakRunning === 0 && d.peakQueued === 0);
  return (
    <div data-testid={`health-lane-occupancy-${lane.lane}`}>
      <h4 className={styles.panelSubtitle}>
        {lane.lane === 'full' ? 'Full / scoped / verify lane' : 'Targeted lane'}{' '}
        (capacity {lane.capacity})
      </h4>
      {idle ? (
        <p className={styles.empty}>No lane activity in this window.</p>
      ) : (
        <div style={{ position: 'relative' }}>
          <div className={styles.bars}>
            {days.map((d) => (
              <div
                key={d.day}
                className={styles.bar}
                title={`${d.day}: peak running ${d.peakRunning}/${lane.capacity}, peak queued ${d.peakQueued}`}
              >
                <div
                  className={styles.waitP90}
                  style={{
                    height: `${((d.peakRunning + d.peakQueued) / max) * 100}%`,
                  }}
                >
                  <div
                    className={styles.waitP50}
                    style={{
                      height: `${
                        d.peakRunning + d.peakQueued > 0
                          ? (d.peakRunning / (d.peakRunning + d.peakQueued)) *
                            100
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div
            data-testid={`health-lane-capacity-${lane.lane}`}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: `${(lane.capacity / max) * 100}%`,
              borderTop: '1px dashed currentColor',
              pointerEvents: 'none',
            }}
          />
        </div>
      )}
    </div>
  );
}

export function LaneOccupancyPanel({ lanes }: { lanes: LaneOccupancyLane[] }) {
  return (
    <section className={styles.panel} data-testid="health-lane-occupancy-panel">
      <h3 className={styles.panelTitle}>Lane occupancy</h3>
      <p className={styles.note}>
        Daily peak of running slots (dark) plus queued runs (light) against the
        currently configured capacity (dashed line).
      </p>
      {lanes.map((lane) => (
        <LaneChart key={lane.lane} lane={lane} />
      ))}
    </section>
  );
}
