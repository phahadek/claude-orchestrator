import {
  useTier3ErrorRate,
  type Tier3ClassifierErrorKind,
  type Tier3ClassifierErrorRateEntry,
} from '../hooks/useTier3ErrorRate';
import styles from './Tier3ErrorRateCard.module.css';

const KIND_LABELS: Record<Tier3ClassifierErrorKind, string> = {
  errored: 'Errored',
  usage_limited: 'Usage-limited',
};

function formatPct(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

function formatWindow(windowSeconds: number): string {
  const days = windowSeconds / (24 * 60 * 60);
  if (Number.isInteger(days)) return `${days}d`;
  const hours = windowSeconds / (60 * 60);
  return Number.isInteger(hours) ? `${hours}h` : `${windowSeconds}s`;
}

function severityClass(entry: Tier3ClassifierErrorRateEntry): string {
  if (entry.rate === null) return styles.severityMuted;
  return entry.chronic ? styles.severityDanger : styles.severityOk;
}

interface Props {
  activeProjectId: string | null;
}

/**
 * Operator-visible rollup for the Tier-3 semantic-advisory classifier's
 * chronic-error-rate signal — errored/usage_limited reported as two
 * independent rolling-window rates against their own configured threshold
 * (see routes/gateState.ts's GET /gate/tier3-error-rate). Purely
 * observational: no gating, no auto-disarm.
 */
export function Tier3ErrorRateCard({ activeProjectId }: Props) {
  const { rates, loading, error } = useTier3ErrorRate(activeProjectId);

  if (!activeProjectId) return null;

  return (
    <div className={styles.card} data-testid="tier3-error-rate-card">
      <h3 className={styles.title}>Tier-3 classifier chronic-error rate</h3>
      {loading && rates.length === 0 && (
        <p className={styles.muted}>Loading…</p>
      )}
      {error && <p className={styles.error}>{error}</p>}
      {!loading && !error && rates.length === 0 && (
        <p className={styles.muted}>No classify calls recorded yet.</p>
      )}
      {rates.length > 0 && (
        <div className={styles.rows}>
          {rates.map((entry) => (
            <div
              key={entry.kind}
              className={styles.row}
              data-testid={`tier3-error-rate-${entry.kind}`}
            >
              <span className={styles.label}>{KIND_LABELS[entry.kind]}</span>
              <span
                className={`${styles.value} ${severityClass(entry)}`}
                data-testid={`tier3-error-rate-${entry.kind}-value`}
              >
                {formatPct(entry.rate)}
              </span>
              <span className={styles.detail}>
                {entry.matched}/{entry.total} · {formatWindow(entry.windowSeconds)}{' '}
                window · threshold {formatPct(entry.threshold)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
