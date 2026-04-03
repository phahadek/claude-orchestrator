import { useState, useEffect, useCallback } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import { formatTokenCount, formatCost } from '@claude-dashboard/backend/src/utils/usage';
import type { TokenAnalyticsResponse, TokenAnalyticsSession } from '@claude-dashboard/backend/src/routes/analytics';
import styles from './AnalyticsPanel.module.css';

interface Props {
  activeProjectId: string | null;
}

type DateRange = '7d' | '30d' | '90d' | 'all';

function dateRangeToMs(range: DateRange): number | null {
  const now = Date.now();
  switch (range) {
    case '7d': return now - 7 * 24 * 60 * 60 * 1000;
    case '30d': return now - 30 * 24 * 60 * 60 * 1000;
    case '90d': return now - 90 * 24 * 60 * 60 * 1000;
    case 'all': return null;
  }
}

function shortLabel(session: TokenAnalyticsSession): string {
  const name = session.taskName ?? session.sessionId.slice(0, 8);
  return name.length > 20 ? name.slice(0, 20) + '…' : name;
}

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
    const fromMs = dateRangeToMs(dateRange);
    if (fromMs != null) params.set('from', String(fromMs));

    fetch(`/api/analytics/tokens?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<TokenAnalyticsResponse>;
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
        setLoading(false);
      });
  }, [activeProjectId, dateRange]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Sessions with tokens only (skip zero-token historical sessions)
  const sessionsWithTokens = data?.sessions.filter((s) => s.totalTokens > 0) ?? [];

  // Chart data: last 20 sessions with tokens, in chronological order
  const chartSessions = [...sessionsWithTokens]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-20);

  const chartData = chartSessions.map((s) => ({
    name: shortLabel(s),
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cost: s.cost,
  }));

  // Top sessions by total tokens
  const topSessions = [...sessionsWithTokens]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <h2 className={styles.title}>Token & Cost Analytics</h2>
        <div className={styles.filters}>
          <span className={styles.filterLabel}>Date range:</span>
          {(['7d', '30d', '90d', 'all'] as DateRange[]).map((r) => (
            <button
              key={r}
              type="button"
              className={`${styles.rangeBtn}${dateRange === r ? ` ${styles.rangeBtnActive}` : ''}`}
              onClick={() => setDateRange(r)}
            >
              {r === 'all' ? 'All time' : r}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className={styles.status}>Loading…</div>}
      {error && <div className={styles.statusError}>{error}</div>}

      {data && !loading && (
        <>
          <div className={styles.summaryRow}>
            <div className={styles.summaryCard}>
              <div className={styles.summaryValue}>{data.totals.sessionCount}</div>
              <div className={styles.summaryLabel}>Sessions</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryValue}>{formatTokenCount(data.totals.totalTokens)}</div>
              <div className={styles.summaryLabel}>Total tokens</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryValue}>{formatTokenCount(data.totals.inputTokens)}</div>
              <div className={styles.summaryLabel}>Input tokens</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryValue}>{formatTokenCount(data.totals.outputTokens)}</div>
              <div className={styles.summaryLabel}>Output tokens</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryValue}>{formatCost(data.totals.totalCost)}</div>
              <div className={styles.summaryLabel}>Est. cost</div>
            </div>
          </div>

          {chartData.length > 0 ? (
            <div className={styles.chartSection}>
              <h3 className={styles.sectionTitle}>Token usage per session (last {chartData.length})</h3>
              <div className={styles.chartContainer}>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 60 }}>
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
                      contentStyle={{ background: '#1e1e2e', border: '1px solid #45475a', borderRadius: 6 }}
                      labelStyle={{ color: '#cdd6f4', marginBottom: 4 }}
                      itemStyle={{ color: '#cdd6f4' }}
                      formatter={(value: number, name: string) => [
                        formatTokenCount(value),
                        name === 'inputTokens' ? 'Input' : 'Output',
                      ]}
                    />
                    <Legend
                      formatter={(value: string) => value === 'inputTokens' ? 'Input' : 'Output'}
                      wrapperStyle={{ color: '#a6adc8', fontSize: 12 }}
                    />
                    <Bar dataKey="inputTokens" stackId="a" fill="#89b4fa" name="inputTokens" />
                    <Bar dataKey="outputTokens" stackId="a" fill="#cba6f7" name="outputTokens" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <div className={styles.emptyChart}>No token data in this date range.</div>
          )}

          {topSessions.length > 0 && (
            <div className={styles.tableSection}>
              <h3 className={styles.sectionTitle}>Top sessions by token usage</h3>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Type</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Total</th>
                    <th>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {topSessions.map((s) => (
                    <tr key={s.sessionId}>
                      <td className={styles.taskNameCell} title={s.taskName ?? s.sessionId}>
                        {s.taskName ?? s.sessionId.slice(0, 8)}
                      </td>
                      <td>{s.sessionType}</td>
                      <td>{formatTokenCount(s.inputTokens)}</td>
                      <td>{formatTokenCount(s.outputTokens)}</td>
                      <td>{formatTokenCount(s.totalTokens)}</td>
                      <td>{formatCost(s.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
