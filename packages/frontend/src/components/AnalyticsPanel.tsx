import { useState, useEffect, useCallback } from "react";
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
  AreaChart,
  Area,
} from "recharts";
import {
  formatTokenCount,
  formatCost,
} from "@claude-orchestrator/backend/src/utils/usage";
import styles from "./AnalyticsPanel.module.css";

// API response types — kept in sync with packages/backend/src/routes/analytics.ts
interface TokenAnalyticsSession {
  sessionId: string;
  taskName: string | null;
  startedAt: number;
  endedAt: number | null;
  sessionType: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

interface TokenAnalyticsResponse {
  sessions: TokenAnalyticsSession[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalCost: number;
    sessionCount: number;
  };
}

interface Props {
  activeProjectId: string | null;
}

type DateRange = "7d" | "30d" | "90d" | "all";

function dateRangeToMs(range: DateRange): number | null {
  const now = Date.now();
  switch (range) {
    case "7d":
      return now - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return now - 30 * 24 * 60 * 60 * 1000;
    case "90d":
      return now - 90 * 24 * 60 * 60 * 1000;
    case "all":
      return null;
  }
}

function shortLabel(session: TokenAnalyticsSession): string {
  const name = session.taskName ?? session.sessionId.slice(0, 8);
  return name.length > 20 ? name.slice(0, 20) + "…" : name;
}

const PIE_COLORS = ["#89b4fa", "#cba6f7", "#a6e3a1", "#fab387"];

export function AnalyticsPanel({ activeProjectId }: Props) {
  const [data, setData] = useState<TokenAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>("30d");

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (activeProjectId) params.set("projectId", activeProjectId);
    const fromMs = dateRangeToMs(dateRange);
    if (fromMs != null) params.set("from", String(fromMs));

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
        setError(
          err instanceof Error ? err.message : "Failed to load analytics",
        );
        setLoading(false);
      });
  }, [activeProjectId, dateRange]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Sessions with tokens only — zero-token historical sessions are excluded from all charts/tables
  const sessionsWithTokens =
    data?.sessions.filter((s) => s.totalTokens > 0) ?? [];

  // Bar chart: last 20 sessions with tokens, in chronological order
  const chartSessions = [...sessionsWithTokens]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-20);

  const barChartData = chartSessions.map((s) => ({
    name: shortLabel(s),
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cost: s.cost,
  }));

  // Pie chart: token breakdown by session type
  const typeMap = new Map<string, number>();
  for (const s of sessionsWithTokens) {
    const key = s.sessionType === "review" ? "Review" : "Code";
    typeMap.set(key, (typeMap.get(key) ?? 0) + s.totalTokens);
  }
  const pieData = [...typeMap.entries()]
    .map(([name, value]) => ({ name, value }))
    .filter((d) => d.value > 0);

  // Cumulative trend: tokens accumulated over sessions, sorted chronologically
  const cumulativeData = [...sessionsWithTokens]
    .sort((a, b) => a.startedAt - b.startedAt)
    .reduce<{ name: string; cumulative: number }[]>((acc, s) => {
      const prev = acc.length > 0 ? acc[acc.length - 1].cumulative : 0;
      acc.push({ name: shortLabel(s), cumulative: prev + s.totalTokens });
      return acc;
    }, []);

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
          {(["7d", "30d", "90d", "all"] as DateRange[]).map((r) => (
            <button
              key={r}
              type="button"
              className={`${styles.rangeBtn}${dateRange === r ? ` ${styles.rangeBtnActive}` : ""}`}
              onClick={() => setDateRange(r)}
            >
              {r === "all" ? "All time" : r}
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
                {formatCost(data.totals.totalCost)}
              </div>
              <div className={styles.summaryLabel}>Est. cost</div>
            </div>
          </div>

          {sessionsWithTokens.length === 0 ? (
            <div className={styles.emptyChart}>
              No token data in this date range.
            </div>
          ) : (
            <>
              {/* ── Token usage bar chart ── */}
              <div className={styles.chartSection}>
                <h3 className={styles.sectionTitle}>
                  Token usage per session (last {barChartData.length})
                </h3>
                <div className={styles.chartContainer}>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart
                      data={barChartData}
                      margin={{ top: 8, right: 16, left: 0, bottom: 60 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#313244" />
                      <XAxis
                        dataKey="name"
                        tick={{ fill: "#a6adc8", fontSize: 11 }}
                        angle={-40}
                        textAnchor="end"
                        interval={0}
                      />
                      <YAxis
                        tickFormatter={(v: number) => formatTokenCount(v)}
                        tick={{ fill: "#a6adc8", fontSize: 11 }}
                        width={55}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#1e1e2e",
                          border: "1px solid #45475a",
                          borderRadius: 6,
                        }}
                        labelStyle={{ color: "#cdd6f4", marginBottom: 4 }}
                        itemStyle={{ color: "#cdd6f4" }}
                        formatter={(value: number, name: string) => [
                          formatTokenCount(value),
                          name === "inputTokens" ? "Input" : "Output",
                        ]}
                      />
                      <Legend
                        formatter={(value: string) =>
                          value === "inputTokens" ? "Input" : "Output"
                        }
                        wrapperStyle={{ color: "#a6adc8", fontSize: 12 }}
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
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* ── Two-column row: pie chart + cumulative trend ── */}
              <div className={styles.chartsRow}>
                {/* Session-type breakdown pie */}
                {pieData.length > 0 && (
                  <div className={styles.chartSection}>
                    <h3 className={styles.sectionTitle}>
                      Tokens by session type
                    </h3>
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
                            labelLine={{ stroke: "#585b70" }}
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
                              background: "#1e1e2e",
                              border: "1px solid #45475a",
                              borderRadius: 6,
                            }}
                            itemStyle={{ color: "#cdd6f4" }}
                            formatter={(value: number) => [
                              formatTokenCount(value),
                              "Tokens",
                            ]}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* Cumulative token trend */}
                {cumulativeData.length > 1 && (
                  <div className={styles.chartSection}>
                    <h3 className={styles.sectionTitle}>
                      Cumulative token usage
                    </h3>
                    <div className={styles.chartContainer}>
                      <ResponsiveContainer width="100%" height={220}>
                        <AreaChart
                          data={cumulativeData}
                          margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                        >
                          <defs>
                            <linearGradient
                              id="cumulativeGrad"
                              x1="0"
                              y1="0"
                              x2="0"
                              y2="1"
                            >
                              <stop
                                offset="5%"
                                stopColor="#89b4fa"
                                stopOpacity={0.3}
                              />
                              <stop
                                offset="95%"
                                stopColor="#89b4fa"
                                stopOpacity={0}
                              />
                            </linearGradient>
                          </defs>
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="#313244"
                          />
                          <XAxis dataKey="name" hide />
                          <YAxis
                            tickFormatter={(v: number) => formatTokenCount(v)}
                            tick={{ fill: "#a6adc8", fontSize: 11 }}
                            width={55}
                          />
                          <Tooltip
                            contentStyle={{
                              background: "#1e1e2e",
                              border: "1px solid #45475a",
                              borderRadius: 6,
                            }}
                            labelStyle={{ color: "#cdd6f4", marginBottom: 4 }}
                            itemStyle={{ color: "#cdd6f4" }}
                            formatter={(value: number) => [
                              formatTokenCount(value),
                              "Cumulative",
                            ]}
                          />
                          <Area
                            type="monotone"
                            dataKey="cumulative"
                            stroke="#89b4fa"
                            fill="url(#cumulativeGrad)"
                            strokeWidth={2}
                            dot={false}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Top sessions table ── */}
              {topSessions.length > 0 && (
                <div className={styles.tableSection}>
                  <h3 className={styles.sectionTitle}>
                    Top sessions by token usage
                  </h3>
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
                          <td
                            className={styles.taskNameCell}
                            title={s.taskName ?? s.sessionId}
                          >
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
        </>
      )}
    </div>
  );
}
