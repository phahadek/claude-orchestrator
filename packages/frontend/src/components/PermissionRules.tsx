import { useState, useEffect } from "react";
import styles from "./PermissionRules.module.css";

interface PermissionRule {
  id: number;
  order_index: number;
  pattern: string;
  match_type: string;
  decision: string;
  label: string | null;
  enabled: number;
}

export function PermissionRules() {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/permission-rules")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<PermissionRule[]>;
      })
      .then((data) => {
        setRules(data);
        setError(null);
      })
      .catch(() => setError("Failed to load permission rules"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className={styles.loading}>Loading rules…</div>;
  if (error) return <div className={styles.error}>{error}</div>;
  if (rules.length === 0) {
    return <div className={styles.empty}>No permission rules configured.</div>;
  }

  return (
    <div className={styles.rules}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>#</th>
            <th>Pattern</th>
            <th>Match</th>
            <th>Decision</th>
            <th>Label</th>
            <th>Enabled</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className={r.enabled ? "" : styles.disabled}>
              <td>{r.order_index}</td>
              <td className={styles.pattern}>{r.pattern}</td>
              <td>{r.match_type}</td>
              <td
                className={r.decision === "allow" ? styles.allow : styles.deny}
              >
                {r.decision}
              </td>
              <td>{r.label ?? "—"}</td>
              <td>{r.enabled ? "✓" : "✗"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
