import type { JobStatus } from '../../api/diagnostics';

interface Props {
  job: JobStatus;
  onTrigger: () => void;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const isPast = diff >= 0;
  if (abs < 60_000) return `${Math.round(abs / 1000)} s ${isPast ? 'ago' : 'from now'}`;
  if (abs < 3_600_000)
    return `${Math.round(abs / 60_000)} min ${isPast ? 'ago' : 'from now'}`;
  return `${Math.round(abs / 3_600_000)} h ${isPast ? 'ago' : 'from now'}`;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function resultBadge(status: JobStatus['lastStatus']): string {
  if (status === 'ok') return '✅ ok';
  if (status === 'failed') return '❌ failed';
  if (status === 'skipped') return '⚠️ skip';
  return '—';
}

const tdStyle: React.CSSProperties = {
  padding: '10px 8px',
  color: '#a6adc8',
  fontSize: 13,
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
};

const triggerBtnStyle: React.CSSProperties = {
  background: '#89b4fa',
  color: '#1e1e2e',
  border: 'none',
  borderRadius: 4,
  padding: '2px 10px',
  fontSize: 12,
  cursor: 'pointer',
};

export function JobRow({ job, onTrigger }: Props) {
  return (
    <tr style={{ borderTop: '1px solid #313244' }}>
      <td style={{ ...tdStyle, color: '#cdd6f4' }}>{job.name}</td>
      <td style={tdStyle}>{formatRelative(job.lastRunAt)}</td>
      <td style={tdStyle}>{formatRelative(job.nextRunAt)}</td>
      <td style={tdStyle}>{resultBadge(job.lastStatus)}</td>
      <td style={tdStyle}>{formatDuration(job.lastDurationMs)}</td>
      <td style={tdStyle}>
        <button
          type="button"
          style={
            job.running
              ? { ...triggerBtnStyle, opacity: 0.5, cursor: 'default' }
              : triggerBtnStyle
          }
          disabled={job.running}
          onClick={onTrigger}
        >
          {job.running ? 'Running…' : 'Trigger'}
        </button>
      </td>
    </tr>
  );
}
