import { Fragment, useState, useEffect, useCallback } from 'react';
import { authedFetch, projectsApi } from '../api/projects';
import type { ProjectMilestone } from '../api/projects';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from 'recharts';
import {
  formatTokenCount,
  formatCost,
} from '@claude-orchestrator/backend/src/utils/usage';
import { costAxisDomain, tokenAxisDomain } from './analyticsChartScales';
import styles from './AnalyticsPanel.module.css';

// API response types — kept in sync with packages/backend/src/routes/analytics.ts
interface TaskRollupRow {
  boardId: string | null;
  taskId: string | null;
  taskName: string | null;
  taskType: string | null;
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

interface TaskSessionRow {
  sessionId: string;
  taskName: string | null;
  startedAt: number;
  endedAt: number | null;
  sessionType: string;
  category: 'planning' | 'execution';
  model: string | null;
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

interface TokenBucketRow {
  bucketStart: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  totalCost: number;
  sessionCount: number;
}

interface TokenTimeseriesResponse {
  range: { from: number; to: number };
  granularity: 'day' | 'week';
  buckets: TokenBucketRow[];
}

interface Props {
  activeProjectId: string | null;
}

type DateRangePreset = '7d' | '30d' | '90d' | 'custom';

function presetToMs(preset: '7d' | '30d' | '90d'): number {
  const now = Date.now();
  switch (preset) {
    case '7d':
      return now - 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return now - 30 * 24 * 60 * 60 * 1000;
    case '90d':
      return now - 90 * 24 * 60 * 60 * 1000;
  }
}

function toDateInputValue(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Epoch ms of the commit that added cache_read_tokens/cache_creation_tokens
// to the sessions table (db/schema.ts). Sessions started before this point
// were never captured with cache figures and default to 0 — indistinguishable
// from a session that genuinely spent no cache tokens — so any query range
// reaching back past this boundary gets a visible marker rather than
// presenting a silently partial cost figure.
const CACHE_TOKEN_MIGRATION_MS = 1785701061000;

function taskLabel(row: TaskRollupRow): string {
  return row.taskName ?? row.boardId ?? '(no task)';
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 12 ? sessionId.slice(0, 12) + '…' : sessionId;
}

type SortKey = 'task' | 'sessions' | 'input' | 'output' | 'cache' | 'cost';
type SortDir = 'asc' | 'desc';

interface SortableColumn {
  key: SortKey;
  label: string;
}

const SORTABLE_COLUMNS: SortableColumn[] = [
  { key: 'task', label: 'Task' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cache', label: 'Cache' },
  { key: 'cost', label: 'Est. cost' },
];

function rollupSortValue(row: TaskRollupRow, key: SortKey): string | number {
  switch (key) {
    case 'task':
      return taskLabel(row).toLowerCase();
    case 'sessions':
      return row.sessionCount;
    case 'input':
      return row.inputTokens;
    case 'output':
      return row.outputTokens;
    case 'cache':
      return row.cacheReadTokens + row.cacheCreationTokens;
    case 'cost':
      return row.totalCost;
  }
}

// Two hue families, one per category, so planning vs execution reads at a
// glance regardless of how many distinct session_types are live — session
// types within a family get progressively lighter shades.
const PLANNING_HUES = ['#89b4fa', '#74c7ec', '#89dceb', '#b4befe', '#6c8ef5'];
const EXECUTION_HUES = ['#fab387', '#f9e2af', '#eba0ac', '#f38ba8', '#f2cdcd'];

function categoryColors(rows: SessionTypeRow[]): Map<string, string> {
  const colors = new Map<string, string>();
  let planningIdx = 0;
  let executionIdx = 0;
  for (const row of rows) {
    if (row.category === 'planning') {
      colors.set(
        row.sessionType,
        PLANNING_HUES[planningIdx % PLANNING_HUES.length],
      );
      planningIdx++;
    } else {
      colors.set(
        row.sessionType,
        EXECUTION_HUES[executionIdx % EXECUTION_HUES.length],
      );
      executionIdx++;
    }
  }
  return colors;
}

export function AnalyticsPanel({ activeProjectId }: Props) {
  const [data, setData] = useState<TokenAnalyticsResponse | null>(null);
  const [timeseries, setTimeseries] = useState<TokenTimeseriesResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangePreset, setRangePreset] = useState<DateRangePreset>('30d');
  const [customFrom, setCustomFrom] = useState<string>(() =>
    toDateInputValue(presetToMs('30d')),
  );
  const [customTo, setCustomTo] = useState<string>(() =>
    toDateInputValue(Date.now()),
  );
  const [milestones, setMilestones] = useState<ProjectMilestone[]>([]);
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string>('');
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(
    new Set(),
  );
  const [taskSessions, setTaskSessions] = useState<
    Map<string, TaskSessionRow[] | 'loading'>
  >(new Map());
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const getRangeMs = useCallback((): { from: number; to: number } => {
    if (rangePreset === 'custom') {
      const from = customFrom
        ? new Date(`${customFrom}T00:00:00.000Z`).getTime()
        : presetToMs('30d');
      const to = customTo
        ? new Date(`${customTo}T23:59:59.999Z`).getTime()
        : Date.now();
      return { from, to };
    }
    return { from: presetToMs(rangePreset), to: Date.now() };
  }, [rangePreset, customFrom, customTo]);

  useEffect(() => {
    setSelectedMilestoneId('');
    if (!activeProjectId) {
      setMilestones([]);
      return;
    }
    let cancelled = false;
    projectsApi
      .listMilestones(activeProjectId)
      .then((list) => {
        if (!cancelled) setMilestones(list);
      })
      .catch(() => {
        if (!cancelled) setMilestones([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    setExpandedTaskIds(new Set());
    setTaskSessions(new Map());

    const { from, to } = getRangeMs();
    const params = new URLSearchParams();
    if (activeProjectId) params.set('projectId', activeProjectId);
    if (selectedMilestoneId) params.set('milestoneId', selectedMilestoneId);
    params.set('from', String(from));
    params.set('to', String(to));

    Promise.all([
      authedFetch(`/api/analytics/tokens?${params}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<TokenAnalyticsResponse>;
      }),
      authedFetch(`/api/analytics/tokens/timeseries?${params}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<TokenTimeseriesResponse>;
      }),
    ])
      .then(([tokens, ts]) => {
        setData(tokens);
        setTimeseries(ts);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : 'Failed to load analytics',
        );
        setLoading(false);
      });
  }, [activeProjectId, selectedMilestoneId, getRangeMs]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const taskRollups = data?.taskRollups ?? [];
  const sessionTypeBreakdown = data?.sessionTypeBreakdown ?? [];

  const filteredRollups = searchQuery.trim()
    ? taskRollups.filter((r) =>
        taskLabel(r).toLowerCase().includes(searchQuery.trim().toLowerCase()),
      )
    : taskRollups;

  const topRollups = [...filteredRollups].sort((a, b) => {
    if (!sortKey) return b.totalCost - a.totalCost;
    const av = rollupSortValue(a, sortKey);
    const bv = rollupSortValue(b, sortKey);
    const cmp =
      typeof av === 'string' && typeof bv === 'string'
        ? av.localeCompare(bv)
        : (av as number) - (bv as number);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const openTask = (taskId: string) => {
    window.dispatchEvent(new CustomEvent('selectTask', { detail: { taskId } }));
  };

  const openSession = (sessionId: string) => {
    window.dispatchEvent(
      new CustomEvent('selectSession', { detail: { sessionId } }),
    );
  };

  const typeColors = categoryColors(sessionTypeBreakdown);
  const typeChartData = sessionTypeBreakdown
    .map((s) => ({
      name: s.sessionType,
      category: s.category,
      value: s.totalCost,
    }))
    .filter((d) => d.value > 0);

  const timeseriesBuckets = timeseries?.buckets ?? [];
  const tokenDomain = tokenAxisDomain(timeseriesBuckets);
  const costDomain = costAxisDomain(timeseriesBuckets);
  const timeseriesChartData = timeseriesBuckets.map((b) => ({
    label: new Date(b.bucketStart).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    }),
    totalTokens: b.totalTokens,
    totalCost: b.totalCost,
  }));

  const toggleExpanded = (boardId: string) => {
    const alreadyExpanded = expandedTaskIds.has(boardId);
    setExpandedTaskIds((prev) => {
      const next = new Set(prev);
      if (alreadyExpanded) next.delete(boardId);
      else next.add(boardId);
      return next;
    });
    if (!alreadyExpanded && !taskSessions.has(boardId)) {
      setTaskSessions((prev) => new Map(prev).set(boardId, 'loading'));
      const { from, to } = getRangeMs();
      const params = new URLSearchParams();
      if (activeProjectId) params.set('projectId', activeProjectId);
      if (selectedMilestoneId) params.set('milestoneId', selectedMilestoneId);
      params.set('from', String(from));
      params.set('to', String(to));
      authedFetch(
        `/api/analytics/tasks/${encodeURIComponent(boardId)}/sessions?${params}`,
      )
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<{ sessions: TaskSessionRow[] }>;
        })
        .then((d) => {
          setTaskSessions((prev) => new Map(prev).set(boardId, d.sessions));
        })
        .catch(() => {
          setTaskSessions((prev) => new Map(prev).set(boardId, []));
        });
    }
  };

  const showMigrationMarker =
    data != null && data.range.from < CACHE_TOKEN_MIGRATION_MS;

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <h2 className={styles.title}>Token & Cost Analytics</h2>
        <div className={styles.filters}>
          <span className={styles.filterLabel}>Date range:</span>
          {(['7d', '30d', '90d', 'custom'] as DateRangePreset[]).map((r) => (
            <button
              key={r}
              type="button"
              className={`${styles.rangeBtn}${rangePreset === r ? ` ${styles.rangeBtnActive}` : ''}`}
              onClick={() => setRangePreset(r)}
            >
              {r === 'custom' ? 'Custom' : r}
            </button>
          ))}
          {rangePreset === 'custom' && (
            <span className={styles.customRange}>
              <input
                type="date"
                aria-label="From date"
                className={styles.dateInput}
                value={customFrom}
                max={customTo}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
              <span>–</span>
              <input
                type="date"
                aria-label="To date"
                className={styles.dateInput}
                value={customTo}
                min={customFrom}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </span>
          )}
        </div>
        <div className={styles.filters}>
          <span className={styles.filterLabel}>Milestone:</span>
          <select
            aria-label="Milestone"
            className={styles.milestoneSelect}
            value={selectedMilestoneId}
            onChange={(e) => setSelectedMilestoneId(e.target.value)}
          >
            <option value="">All milestones</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search tasks…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search tasks"
        />
      </div>

      {loading && <div className={styles.status}>Loading…</div>}
      {error && <div className={styles.statusError}>{error}</div>}

      {showMigrationMarker && (
        <div className={styles.migrationMarker}>
          Excludes cache spend before{' '}
          {new Date(CACHE_TOKEN_MIGRATION_MS).toLocaleDateString()} — cost
          figures for sessions started before this date reflect input/output
          tokens only.
        </div>
      )}

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

          {/* ── Token consumption over time, dual-axis (cost + raw tokens) ── */}
          {timeseriesBuckets.length > 0 && (
            <div className={styles.chartSection}>
              <h3 className={styles.sectionTitle}>
                Token consumption over time
              </h3>
              <div className={styles.legendRow}>
                <span className={styles.legendItem}>
                  <span
                    className={styles.legendSwatch}
                    style={{ background: '#89b4fa' }}
                  />
                  Tokens
                </span>
                <span className={styles.legendItem}>
                  <span
                    className={styles.legendSwatch}
                    style={{ background: '#fab387' }}
                  />
                  Cost
                </span>
              </div>
              <div className={styles.chartContainer}>
                <ResponsiveContainer width="100%" minHeight={220}>
                  <LineChart
                    data={timeseriesChartData}
                    margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#313244" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: '#a6adc8', fontSize: 11 }}
                    />
                    <YAxis
                      yAxisId="tokens"
                      orientation="left"
                      domain={tokenDomain}
                      tickFormatter={(v: number) => formatTokenCount(v)}
                      tick={{ fill: '#89b4fa', fontSize: 11 }}
                      width={55}
                    />
                    <YAxis
                      yAxisId="cost"
                      orientation="right"
                      domain={costDomain}
                      tickFormatter={(v: number) => formatCost(v)}
                      tick={{ fill: '#fab387', fontSize: 11 }}
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
                        name === 'Cost' ? formatCost(value) : formatTokenCount(value),
                        name,
                      ]}
                    />
                    <Line
                      yAxisId="tokens"
                      type="monotone"
                      dataKey="totalTokens"
                      name="Tokens"
                      stroke="#89b4fa"
                      dot={false}
                      strokeWidth={2}
                    />
                    <Line
                      yAxisId="cost"
                      type="monotone"
                      dataKey="totalCost"
                      name="Cost"
                      stroke="#fab387"
                      dot={false}
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {taskRollups.length === 0 ? (
            <div className={styles.emptyChart}>
              No token data in this date range.
            </div>
          ) : (
            <>
              {/* ── Per-type breakdown, colored by planning/execution category ── */}
              {typeChartData.length > 0 && (
                <div className={styles.chartSection}>
                  <h3 className={styles.sectionTitle}>Cost by session type</h3>
                  <div className={styles.legendRow}>
                    <span className={styles.legendItem}>
                      <span
                        className={styles.legendSwatch}
                        style={{ background: PLANNING_HUES[0] }}
                      />
                      Planning
                    </span>
                    <span className={styles.legendItem}>
                      <span
                        className={styles.legendSwatch}
                        style={{ background: EXECUTION_HUES[0] }}
                      />
                      Execution
                    </span>
                  </div>
                  <div className={styles.chartContainer}>
                    <ResponsiveContainer width="100%" minHeight={220}>
                      <BarChart
                        data={typeChartData}
                        margin={{ top: 8, right: 16, left: 0, bottom: 40 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#313244" />
                        <XAxis
                          dataKey="name"
                          tick={{ fill: '#a6adc8', fontSize: 11 }}
                          angle={-30}
                          textAnchor="end"
                          interval={0}
                        />
                        <YAxis
                          tickFormatter={(v: number) => formatCost(v)}
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
                          formatter={(value: number) => [
                            formatCost(value),
                            'Cost',
                          ]}
                        />
                        <Bar dataKey="value" name="Cost">
                          {typeChartData.map((d) => (
                            <Cell key={d.name} fill={typeColors.get(d.name)} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* ── Task rollup table, primary view, with session drill-in ── */}
              <div className={styles.tableSection}>
                <h3 className={styles.sectionTitle}>Cost by task</h3>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th />
                      {SORTABLE_COLUMNS.map((col) => (
                        <th key={col.key}>
                          <button
                            type="button"
                            className={styles.sortHeaderBtn}
                            onClick={() => handleSort(col.key)}
                          >
                            {col.label}
                            {sortKey === col.key
                              ? sortDir === 'asc'
                                ? ' ▲'
                                : ' ▼'
                              : ''}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {topRollups.map((r) => {
                      const key = r.boardId ?? '__none__';
                      const expanded = expandedTaskIds.has(key);
                      const sessionsForTask = taskSessions.get(key);
                      const name = taskLabel(r);
                      return (
                        <Fragment key={key}>
                          <tr
                            className={styles.rollupRow}
                            onClick={() => toggleExpanded(key)}
                          >
                            <td className={styles.expandCell}>
                              {expanded ? '▾' : '▸'}
                            </td>
                            <td className={styles.taskNameCell} title={name}>
                              {r.taskType && (
                                <span className={styles.typeBadge}>
                                  {r.taskType}
                                </span>
                              )}
                              {r.taskId ? (
                                <button
                                  type="button"
                                  className={styles.taskLink}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openTask(r.taskId as string);
                                  }}
                                >
                                  {name}
                                </button>
                              ) : (
                                <span>{name}</span>
                              )}
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
                          {expanded && sessionsForTask === 'loading' && (
                            <tr className={styles.sessionRow}>
                              <td />
                              <td colSpan={6}>Loading sessions…</td>
                            </tr>
                          )}
                          {expanded &&
                            sessionsForTask !== undefined &&
                            sessionsForTask !== 'loading' &&
                            sessionsForTask.map((s) => (
                              <tr
                                key={s.sessionId}
                                className={styles.sessionRow}
                                onClick={() => openSession(s.sessionId)}
                              >
                                <td />
                                <td
                                  className={styles.sessionNameCell}
                                  title={s.sessionId}
                                >
                                  <span
                                    className={styles.legendSwatch}
                                    style={{
                                      background: typeColors.get(s.sessionType),
                                    }}
                                  />
                                  {s.sessionType} ·{' '}
                                  {shortSessionId(s.sessionId)}
                                </td>
                                <td>—</td>
                                <td>{formatTokenCount(s.inputTokens)}</td>
                                <td>{formatTokenCount(s.outputTokens)}</td>
                                <td>
                                  {formatTokenCount(
                                    s.cacheReadTokens + s.cacheCreationTokens,
                                  )}
                                </td>
                                <td>{formatCost(s.totalCost)}</td>
                              </tr>
                            ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
