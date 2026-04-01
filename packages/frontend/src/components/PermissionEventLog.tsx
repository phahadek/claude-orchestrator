import { useState, useEffect, useRef } from 'react';
import { taskNameFromNotionUrl } from '../utils/notionUrl';
import styles from './PermissionEventLog.module.css';

interface PermissionEventRow {
  id: number;
  session_id: string;
  tool_name: string;
  proposed_action: string | null;
  decision: 'allow' | 'deny' | 'escalate';
  rule_matched: string | null;
  decided_at: number;
  notion_task_url: string | null;
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatRowsForClipboard(rows: PermissionEventRow[]): string {
  const header = `Permission Event Log — ${new Date().toISOString()}`;
  const lines = rows.map((row) => {
    const decision = row.decision;
    const tool = row.tool_name;
    const action = row.proposed_action ?? '';
    const rule = row.rule_matched ?? 'none (escalated)';
    const session = row.notion_task_url
      ? taskNameFromNotionUrl(row.notion_task_url)
      : row.session_id.slice(0, 8);
    return `[${decision}] ${tool} | ${action} | rule: ${rule} | session: ${session}`;
  });
  return [header, '', ...lines].join('\n');
}

interface ClearModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

function ClearModal({ onConfirm, onCancel }: ClearModalProps) {
  // Clicking outside or pressing Escape cancels; only clicking Delete confirms
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onCancel();
  }

  return (
    <div className={styles.modalOverlay} ref={overlayRef} onClick={handleOverlayClick}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <p className={styles.modalMessage}>
          Delete all permission event history? This cannot be undone.
        </p>
        <div className={styles.modalActions}>
          <button type="button" className={styles.modalCancel} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={styles.modalDelete} onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function PermissionEventLog() {
  const [rows, setRows] = useState<PermissionEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [showClearModal, setShowClearModal] = useState(false);

  async function fetchEvents() {
    try {
      const res = await fetch('/api/permission-events');
      if (!res.ok) throw new Error(`${res.status}`);
      setRows((await res.json()) as PermissionEventRow[]);
      setError(null);
    } catch {
      setError('Failed to load permission events');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchEvents();
    const interval = setInterval(fetchEvents, 30_000);
    return () => clearInterval(interval);
  }, []);

  function handleCopy() {
    const text = formatRowsForClipboard(rows);
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyFeedback('copied');
        setTimeout(() => setCopyFeedback('idle'), 1500);
      },
      () => {
        setCopyFeedback('failed');
        setTimeout(() => setCopyFeedback('idle'), 1500);
      },
    );
  }

  async function handleClearConfirm() {
    setShowClearModal(false);
    try {
      const res = await fetch('/api/permission-events', { method: 'DELETE' });
      if (!res.ok) throw new Error(`${res.status}`);
      setRows([]);
    } catch {
      setError('Failed to clear events');
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.count}>{rows.length} event{rows.length !== 1 ? 's' : ''}</span>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.copyBtn}
            onClick={handleCopy}
            disabled={rows.length === 0}
          >
            {copyFeedback === 'copied' ? '✓ Copied' : copyFeedback === 'failed' ? '✗ Failed' : 'Copy'}
          </button>
          <button
            type="button"
            className={styles.clearBtn}
            onClick={() => setShowClearModal(true)}
            disabled={rows.length === 0}
          >
            Clear
          </button>
        </div>
      </div>

      {loading && <p className={styles.status}>Loading…</p>}
      {error && <p className={styles.error}>{error}</p>}

      {!loading && !error && rows.length === 0 && (
        <p className={styles.status}>No permission events recorded yet.</p>
      )}

      {rows.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Time</th>
              <th>Session</th>
              <th>Tool</th>
              <th>Action</th>
              <th>Decision</th>
              <th>Rule</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <EventRow key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      )}

      {showClearModal && (
        <ClearModal
          onConfirm={handleClearConfirm}
          onCancel={() => setShowClearModal(false)}
        />
      )}
    </div>
  );
}

function EventRow({ row }: { row: PermissionEventRow }) {
  const [expanded, setExpanded] = useState(false);
  const action = row.proposed_action ?? '';
  const truncated = action.length > 60 && !expanded;
  const displayAction = truncated ? action.slice(0, 60) + '…' : action;
  const sessionName = row.notion_task_url
    ? taskNameFromNotionUrl(row.notion_task_url)
    : row.session_id.slice(0, 8);

  return (
    <tr>
      <td className={styles.timeCell} title={new Date(row.decided_at).toISOString()}>
        {relativeTime(row.decided_at)}
      </td>
      <td className={styles.sessionCell} title={row.notion_task_url ?? row.session_id}>
        {sessionName}
      </td>
      <td className={styles.toolCell}>{row.tool_name}</td>
      <td className={styles.actionCell}>
        <span className={styles.actionText}>{displayAction}</span>
        {action.length > 60 && (
          <button
            type="button"
            className={styles.expandBtn}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'less' : 'more'}
          </button>
        )}
      </td>
      <td>
        <span
          className={
            row.decision === 'allow'
              ? styles.allow
              : row.decision === 'deny'
              ? styles.deny
              : styles.escalate
          }
        >
          {row.decision}
        </span>
      </td>
      <td className={styles.ruleCell}>{row.rule_matched ?? '—'}</td>
    </tr>
  );
}
