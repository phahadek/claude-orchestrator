import { useSchedulerStatus } from '../hooks/useSchedulerStatus';
import { JobRow } from '../components/Settings/JobRow';
import styles from '../components/Settings.module.css';

const thStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#6c7086',
  fontSize: 12,
  textAlign: 'left',
};

export function SettingsSystemHealth() {
  const { jobs, loading, error, trigger } = useSchedulerStatus();

  if (loading) return <p className={styles.muted}>Loading…</p>;

  return (
    <div>
      {error && <p className={styles.error}>{error}</p>}
      <h3 className={styles.sectionTitle}>Scheduler Jobs</h3>
      {jobs.length === 0 ? (
        <p className={styles.muted}>No scheduler jobs registered.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>Job</th>
              <th style={thStyle}>Last run</th>
              <th style={thStyle}>Next run</th>
              <th style={thStyle}>Result</th>
              <th style={thStyle}>Duration</th>
              <th style={thStyle}>24h runs</th>
              <th style={thStyle}>24h errors</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <JobRow
                key={job.name}
                job={job}
                onTrigger={() => void trigger(job.name)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
