import { useState, useEffect, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { architectureApi } from '../api/architecture';
import type { ArchUnit, ArchUnitKind, ArchUnitStatus } from '../api/architecture';
import styles from './ArchitecturePanel.module.css';

const KIND_OPTIONS: ArchUnitKind[] = [
  'subsystem',
  'invariant',
  'decision',
  'contract',
  'reference',
];

const STATUS_OPTIONS: ArchUnitStatus[] = ['active', 'deferred', 'superseded'];

export function ArchitecturePanel() {
  const [units, setUnits] = useState<ArchUnit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [kindFilter, setKindFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<ArchUnitStatus | ''>('active');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    architectureApi
      .listUnits({
        kind: (kindFilter as ArchUnitKind) || undefined,
        status: statusFilter || undefined,
      })
      .then((result) => {
        if (cancelled) return;
        setUnits(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kindFilter, statusFilter]);

  useEffect(() => {
    setSelectedId((current) =>
      current && units.some((u) => u.id === current)
        ? current
        : (units[0]?.id ?? null),
    );
  }, [units]);

  const grouped = useMemo(() => {
    const byTopic = new Map<string, ArchUnit[]>();
    for (const unit of units) {
      const list = byTopic.get(unit.topic) ?? [];
      list.push(unit);
      byTopic.set(unit.topic, list);
    }
    return [...byTopic.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [units]);

  const selectedUnit = units.find((u) => u.id === selectedId) ?? null;

  return (
    <div className={styles.panel} data-testid="architecture-panel">
      <div className={styles.header}>
        <h2 className={styles.title}>Architecture</h2>
        <label className={styles.filterField}>
          Kind
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
          >
            <option value="">All</option>
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filterField}>
          Status
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as ArchUnitStatus | '')
            }
          >
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && <p className={styles.muted}>Loading units…</p>}
      {error && <p className={styles.error}>{error}</p>}

      {!loading && !error && units.length === 0 && (
        <p className={styles.muted}>No architecture units match these filters.</p>
      )}

      {!loading && !error && units.length > 0 && (
        <div className={styles.layout}>
          <nav className={styles.topicList} aria-label="Topics">
            {grouped.map(([topic, topicUnits]) => (
              <div key={topic} className={styles.topicGroup}>
                <div className={styles.topicHeading}>{topic}</div>
                {topicUnits.map((unit) => (
                  <button
                    key={unit.id}
                    type="button"
                    className={`${styles.unitLink}${
                      unit.id === selectedId ? ` ${styles.unitLinkActive}` : ''
                    }`}
                    onClick={() => setSelectedId(unit.id)}
                  >
                    <span className={styles.unitLinkTitle}>{unit.title}</span>
                    <span className={styles.unitLinkKind}>{unit.kind}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className={styles.detail}>
            {selectedUnit ? (
              <>
                <div className={styles.detailHeader}>
                  <h3 className={styles.detailTitle}>{selectedUnit.title}</h3>
                  <div className={styles.badges}>
                    <span className={styles.badge}>{selectedUnit.kind}</span>
                    <span
                      className={`${styles.badge}${
                        selectedUnit.status === 'active'
                          ? ` ${styles.badgeActive}`
                          : ''
                      }`}
                    >
                      {selectedUnit.status}
                    </span>
                    <span className={styles.badge}>{selectedUnit.topic}</span>
                  </div>
                  {selectedUnit.regions.length > 0 && (
                    <div className={styles.regions}>
                      {selectedUnit.regions.map((region) => (
                        <span key={region} className={styles.regionChip}>
                          {region}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className={styles.body}>
                  <Markdown remarkPlugins={[remarkGfm]}>
                    {selectedUnit.body}
                  </Markdown>
                </div>
              </>
            ) : (
              <p className={styles.muted}>Select a unit to view its detail.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
