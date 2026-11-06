import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { useFlowHealthAttention } from '../hooks/useFlowHealthAttention';
import styles from './FlowHealthPanel.module.css';

interface Props {
  activeProjectId: string | null;
}

/** Locked by decision.pickOne e83696d6-cec4-45d7-af55-e0357cc0db93 — mirrors FlowHealthRegressionSnapshotJob's REGRESSION_THRESHOLD_MS. */
const REGRESSION_THRESHOLD_MS = 60 * 60 * 1000;

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const minutes = Math.round(ms / 60000);
  return `${minutes}m`;
}

function formatTs(ts: string): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function FlowHealthPanel({ activeProjectId }: Props) {
  const { data } = useFlowHealthAttention(activeProjectId);
  const history = data?.history ?? [];
  const latest = history.length > 0 ? history[history.length - 1] : null;
  const regressed = data?.signal != null;

  const chartData = history.map((row) => ({
    ts: row.ts,
    label: formatTs(row.ts),
    p50Minutes:
      row.p50_wall_clock_ms !== null ? row.p50_wall_clock_ms / 60000 : null,
    status: row.status,
  }));

  return (
    <div className={styles.panel}>
      <h2 className={styles.title}>Flow Health</h2>

      <div
        className={`${styles.statusBanner} ${
          regressed ? styles.statusBannerRegressed : styles.statusBannerOk
        }`}
      >
        {regressed
          ? (data?.signal?.message ?? 'Flow health regressed')
          : latest
            ? `Flow healthy — trailing p50 wall-clock ${formatDuration(latest.p50_wall_clock_ms)} (threshold ${formatDuration(REGRESSION_THRESHOLD_MS)})`
            : 'No flow-health snapshots recorded yet.'}
      </div>

      <div className={styles.chartCard}>
        {chartData.length === 0 ? (
          <div className={styles.empty}>
            No flow-health snapshot history to chart yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#313244" />
              <XAxis dataKey="label" stroke="#a6adc8" fontSize={12} />
              <YAxis
                stroke="#a6adc8"
                fontSize={12}
                label={{
                  value: 'p50 wall-clock (min)',
                  angle: -90,
                  position: 'insideLeft',
                  fill: '#a6adc8',
                  fontSize: 12,
                }}
              />
              <Tooltip
                formatter={(value: number | string) =>
                  typeof value === 'number' ? `${Math.round(value)}m` : value
                }
              />
              <ReferenceLine
                y={REGRESSION_THRESHOLD_MS / 60000}
                stroke="#f38ba8"
                strokeDasharray="4 4"
                label={{
                  value: 'regression threshold',
                  fill: '#f38ba8',
                  fontSize: 11,
                  position: 'insideTopRight',
                }}
              />
              <Line
                type="monotone"
                dataKey="p50Minutes"
                stroke="#89b4fa"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
