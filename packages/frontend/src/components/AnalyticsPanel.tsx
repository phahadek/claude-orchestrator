import { useState, useEffect, useCallback } from 'react';
import { authedFetch } from '../api/projects';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import {
  formatTokenCount,
  formatCost,
} from '@claude-orchestrator/backend/src/utils/usage';
import styles from './AnalyticsPanel.module.css';

// API response types — kept in sync with packages/backend/src/routes/analytics.ts
interface TaskRollupRow {
  boardId: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCost: number;
}

interface SessionTypeRow {
  sessionType: string;
  category: 'planning' | 'execution';
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCost: number;
}

interface TokenAnalyticsResponse {
  range: { from: number; to: number };
  taskRollups: TaskRollupRow[];
  sessionTypeBreakdown: SessionTypeRow[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    totalCost: number;
    sessionCount: number;
  };
}

interface Props {
  activeProjectId: string | null;
}

type DateRange = '7d' | '30d' | '90d';

function dateRangeToMs(range: DateRange): number {
  const now = Date.now();
  switch (range) {
    case '7d':
      return now - 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return now - 30 * 24 * 60 * 60 * 1000;
    case '90d':
      return now - 90 * 24 * 60 * 60 * 1000;
  }
}

function shortLabel(rollup: TaskRollupRow): string {
  const name = rollup.boardId ?? '(no task)';
  return name.length > 20 ? name.slice(0, 20) + '…' : name;
}

const PIE_COLORS = ['#89b4fa', '#cba6f7', '#a6e3a1', '#fab387'];

export function AnalyticsPanel({ activeProjectId }: Props) {
  const [data, setData] = useState<TokenAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>('30d');

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (activeProjectId) params.set('projectId', activeProjectId);
    params.set('from', String(dateRangeToMs(dateRange)));

    authedFetch(`/api/analytics/tokens?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<TokenAnalyticsResponse>;
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : 'Failed to load analytics',
        );
        setLoading(false);
      });
  }, [activeProjectId, dateRange]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const taskRollups = data?.taskRollups ?? [];
  const sessionTypeBreakdown = data?.sessionTypeBreakdown ?? [];

  // Bar chart: top 20 task rollups by cost
  const chartRollups = [...taskRollups]
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, 20);

  const barChartData = chartRollups.map((r) => ({
    name: shortLabel(r),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheTokens: r.cacheReadTokens + r.cacheCreationTokens,
    cost: r.totalCost,
  }));

  // Pie chart: cost breakdown by session type
  const pieData = sessionTypeBreakdown
    .map((s) => ({ name: s.sessionType, value: s.totalCost }))
    .filter((d) => d.value > 0);

  const topRollups = [...taskRollups]
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, 10);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <h2 className={styles.title}>Token & Cost Analytics</h2>
        <div className={styles.filters}>
          <span className={styles.filterLabel}>Date range:</span>
          {(['7d', '30d', '90d'] as DateRange[]).map((r) => (
            <button
              key={r}
              type="button"
              className={`${styles.rangeBtn}${dateRange === r ? ` ${styles.rangeBtnActive}` : ''}`}
              onClick={() => setDateRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className={styles.status}>Loading…</div>}
      {error && <div className={styles.statusError}>{error}</div>}

      {data && !loading && (
        <>
          {/* ── Summary stat cards ── */}
          <div className={styles.summaryRow}>
            <div className={styles.summaryCard}>
              <div className={styles.summaryValue}>
                {data.totals.sessionCount}
              </div>
              <div className={styles.summaryLabel}>Sessions</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryValue}>
                {formatTokenCount(data.totals.totalTokens)}
              </div>
              <div className={styles.summaryLabel}>Total tokens</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryValue}>
                {formatTokenCount(data.totals.inputTokens)}
              </div>
              <div className={styles.summaryLabel}>Input tokens</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryValue}>
                {formatTokenCount(data.totals.outputTokens)}
              </div>
              <div className={styles.summaryLabel}>Output tokens</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryValue}>
                {formatTokenCount(
                  data.totals.cacheReadTokens + data.totals.cacheCreationTokens,
                )}
              </div>
              <div className={styles.summaryLabel}>Cache tokens</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryValue}>
                {formatCost(data.totals.totalCost)}
              </div>
              <div className={styles.summaryLabel}>Est. cost</div>
            </div>
          </div>

          {taskRollups.length === 0 ? (
            <div className={styles.emptyChart}>
              No token data in this date range.
            </div>
          ) : (
            <>
              {/* ── Cost by task rollup bar chart ── */}
              <div className={styles.chartSection}>
                <h3 className={styles.sectionTitle}>
                  Tokens per task (top {barChartData.length})
                </h3>
                <div className={styles.chartContainer}>
                  <ResponsiveContainer width="100%" minHeight={240}>
                    <BarChart
                      data={barChartData}
                      margin={{ top: 8, right: 16, left: 0, bottom: 60 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#313244" />
                      <XAxis
                        dataKey="name"
                        tick={{ fill: '#a6adc8', fontSize: 11 }}
                        angle={-40}
                        textAnchor="end"
                        interval={0}
                      />
                      <YAxis
                        tickFormatter={(v: number) => formatTokenCount(v)}
                        tick={{ fill: '#a6adc8', fontSize: 11 }}
                        width={55}
                      />
                      <Tooltip
                        contentStyle={{
                          background: '#1e1e2e',
                          border: '1px solid #45475a',
                          borderRadius: 6,
                        }}
                        labelStyle={{ color: '#cdd6f4', marginBottom: 4 }}
                        itemStyle={{ color: '#cdd6f4' }}
                        formatter={(value: number, name: string) => [
                          formatTokenCount(value),
                          name === 'inputTokens'
                            ? 'Input'
                            : name === 'outputTokens'
                              ? 'Output'
                              : 'Cache',
                        ]}
                      />
                      <Legend
                        formatter={(value: string) =>
                          value === 'inputTokens'
                            ? 'Input'
                            : value === 'outputTokens'
                              ? 'Output'
                              : 'Cache'
                        }
                        wrapperStyle={{ color: '#a6adc8', fontSize: 12 }}
                      />
                      <Bar
                        dataKey="inputTokens"
                        stackId="a"
                        fill="#89b4fa"
                        name="inputTokens"
                      />
                      <Bar
                        dataKey="outputTokens"
                        stackId="a"
                        fill="#cba6f7"
                        name="outputTokens"
                      />
                      <Bar
                        dataKey="cacheTokens"
                        stackId="a"
                        fill="#a6e3a1"
                        name="cacheTokens"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Cost breakdown by session type pie */}
              {pieData.length > 0 && (
                <div className={styles.chartSection}>
                  <h3 className={styles.sectionTitle}>Cost by session type</h3>
                  <div
                    className={`${styles.chartContainer} ${styles.pieContainer}`}
                  >
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie
                          data={pieData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={80}
                          label={({
                            name,
                            percent,
                          }: {
                            name: string;
                            percent: number;
                          }) => `${name} ${Math.round(percent * 100)}%`}
                          labelLine={{ stroke: '#585b70' }}
                        >
                          {pieData.map((_entry, index) => (
                            <Cell
                              key={index}
                              fill={PIE_COLORS[index % PIE_COLORS.length]}
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: '#1e1e2e',
                            border: '1px solid #45475a',
                            borderRadius: 6,
                          }}
                          itemStyle={{ color: '#cdd6f4' }}
                          formatter={(value: number) => [
                            formatCost(value),
                            'Cost',
                          ]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* ── Top task rollups table ── */}
              {topRollups.length > 0 && (
                <div className={styles.tableSection}>
                  <h3 className={styles.sectionTitle}>Top tasks by cost</h3>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Task</th>
                        <th>Sessions</th>
                        <th>Input</th>
                        <th>Output</th>
                        <th>Cache</th>
                        <th>Est. cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topRollups.map((r) => (
                        <tr key={r.boardId ?? '(none)'}>
                          <td
                            className={styles.taskNameCell}
                            title={r.boardId ?? '(no task)'}
                          >
                            {r.boardId ?? '(no task)'}
                          </td>
                          <td>{r.sessionCount}</td>
                          <td>{formatTokenCount(r.inputTokens)}</td>
                          <td>{formatTokenCount(r.outputTokens)}</td>
                          <td>
                            {formatTokenCount(
                              r.cacheReadTokens + r.cacheCreationTokens,
                            )}
                          </td>
                          <td>{formatCost(r.totalCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
