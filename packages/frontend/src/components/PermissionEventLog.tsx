import { useState, useEffect } from "react";
import { taskNameFromNotionUrl } from "../utils/notionUrl";
import styles from "./PermissionEventLog.module.css";

interface PermissionDenialRow {
  id: number;
  session_id: string;
  tool_name: string;
  tool_use_id: string;
  tool_input: string; // JSON string
  timestamp: number;
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

function formatRowsForClipboard(rows: PermissionDenialRow[]): string {
  const header = `Permission Denials — ${new Date().toISOString()}`;
  const lines = rows.map((row) => {
    const tool = row.tool_name;
    const input = row.tool_input;
    const session = row.notion_task_url
      ? taskNameFromNotionUrl(row.notion_task_url)
      : row.session_id.slice(0, 8);
    return `[denied] ${tool} | ${input} | session: ${session}`;
  });
  return [header, "", ...lines].join("\n");
}

export function PermissionEventLog() {
  const [rows, setRows] = useState<PermissionDenialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const [showClearModal, setShowClearModal] = useState(false);

  async function fetchDenials() {
    try {
      const res = await fetch("/api/permission-denials");
      if (!res.ok) throw new Error(`${res.status}`);
      setRows((await res.json()) as PermissionDenialRow[]);
      setError(null);
    } catch {
      setError("Failed to load permission denials");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchDenials();
    const interval = setInterval(fetchDenials, 30_000);
    return () => clearInterval(interval);
  }, []);

  async function handleClear() {
    try {
      const res = await fetch("/api/permission-denials", { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status}`);
      setRows([]);
    } catch {
      setError("Failed to clear denials");
    } finally {
      setShowClearModal(false);
    }
  }

  function handleCopy() {
    const text = formatRowsForClipboard(rows);
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyFeedback("copied");
        setTimeout(() => setCopyFeedback("idle"), 1500);
      },
      () => {
        setCopyFeedback("failed");
        setTimeout(() => setCopyFeedback("idle"), 1500);
      },
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.count}>
          {rows.length} denial{rows.length !== 1 ? "s" : ""}
        </span>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.copyBtn}
            onClick={handleCopy}
            disabled={rows.length === 0}
          >
            {copyFeedback === "copied"
              ? "✓ Copied"
              : copyFeedback === "failed"
                ? "✗ Failed"
                : "Copy"}
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
        <p className={styles.status}>No permission denials recorded yet.</p>
      )}

      {rows.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Time</th>
              <th>Session</th>
              <th>Tool</th>
              <th>Input</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <DenialRow key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      )}

      {showClearModal && (
        <div
          className={styles.modalOverlay}
          onClick={() => setShowClearModal(false)}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <p className={styles.modalMessage}>
              Clear {rows.length} denial{rows.length !== 1 ? "s" : ""}? This
              cannot be undone.
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.modalCancel}
                onClick={() => setShowClearModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.modalDelete}
                onClick={() => void handleClear()}
              >
                Clear all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DenialRow({ row }: { row: PermissionDenialRow }) {
  const [expanded, setExpanded] = useState(false);
  const inputText = (() => {
    try {
      return JSON.stringify(JSON.parse(row.tool_input), null, 2);
    } catch {
      return row.tool_input;
    }
  })();
  const truncated = inputText.length > 80 && !expanded;
  const displayInput = truncated ? inputText.slice(0, 80) + "…" : inputText;
  const sessionName = row.notion_task_url
    ? taskNameFromNotionUrl(row.notion_task_url)
    : row.session_id.slice(0, 8);

  return (
    <tr>
      <td
        className={styles.timeCell}
        title={new Date(row.timestamp).toISOString()}
      >
        {relativeTime(row.timestamp)}
      </td>
      <td
        className={styles.sessionCell}
        title={row.notion_task_url ?? row.session_id}
      >
        {sessionName}
      </td>
      <td className={styles.toolCell}>{row.tool_name}</td>
      <td className={styles.actionCell}>
        <span className={styles.actionText}>{displayInput}</span>
        {inputText.length > 80 && (
          <button
            type="button"
            className={styles.expandBtn}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "less" : "more"}
          </button>
        )}
      </td>
    </tr>
  );
}
