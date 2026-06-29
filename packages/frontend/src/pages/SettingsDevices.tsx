import { useState, useEffect, useCallback } from 'react';
import { authedFetch } from '../api/projects';
import styles from '../components/Settings.module.css';

interface Device {
  id: string;
  name: string;
  userAgent: string | null;
  lastIp: string | null;
  lastSeen: number | null;
  enrolledAt: number;
  revoked: boolean;
}

async function fetchDevices(): Promise<Device[]> {
  const res = await authedFetch('/api/enrollment/devices');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<Device[]>;
}

async function renameDevice(id: string, name: string): Promise<void> {
  const res = await authedFetch(
    `/api/enrollment/devices/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) throw new Error(`${res.status}`);
}

async function revokeDevice(id: string): Promise<void> {
  const res = await authedFetch(
    `/api/enrollment/devices/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`${res.status}`);
}

function formatDate(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function SettingsDevices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    fetchDevices()
      .then(setDevices)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRename(id: string) {
    try {
      await renameDevice(id, editName);
      setEditingId(null);
      load();
    } catch {
      setError('Failed to rename device');
    }
  }

  async function handleRevoke(id: string, name: string) {
    if (!confirm(`Revoke access for "${name}"? This cannot be undone.`)) return;
    try {
      await revokeDevice(id);
      load();
    } catch {
      setError('Failed to revoke device');
    }
  }

  if (loading) return <p className={styles.muted}>Loading devices…</p>;

  return (
    <div>
      {error && <p className={styles.error}>{error}</p>}
      <h3 className={styles.sectionTitle}>Enrolled Devices</h3>
      <p className={styles.hint}>
        Devices that are authorized to access this orchestrator. Revoke access
        for any device you no longer recognize.
      </p>

      {devices.length === 0 ? (
        <p className={styles.muted}>No devices enrolled.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#6c7086', fontSize: 12 }}>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Last seen</th>
              <th style={thStyle}>Enrolled</th>
              <th style={thStyle}>IP</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr
                key={d.id}
                style={{
                  borderTop: '1px solid #313244',
                  opacity: d.revoked ? 0.5 : 1,
                }}
              >
                <td style={tdStyle}>
                  {editingId === d.id ? (
                    <span style={{ display: 'flex', gap: 4 }}>
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        style={inputStyle}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleRename(d.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        autoFocus
                      />
                      <button
                        style={smallBtnStyle}
                        onClick={() => void handleRename(d.id)}
                      >
                        Save
                      </button>
                      <button
                        style={{ ...smallBtnStyle, background: 'transparent' }}
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span
                      style={{ cursor: 'pointer', color: '#cdd6f4' }}
                      title="Click to rename"
                      onClick={() => {
                        setEditingId(d.id);
                        setEditName(d.name);
                      }}
                    >
                      {d.name}
                    </span>
                  )}
                </td>
                <td style={tdStyle}>{formatDate(d.lastSeen)}</td>
                <td style={tdStyle}>{formatDate(d.enrolledAt)}</td>
                <td style={tdStyle}>{d.lastIp ?? '—'}</td>
                <td style={tdStyle}>
                  {!d.revoked && (
                    <button
                      style={revokeStyle}
                      onClick={() => void handleRevoke(d.id, d.name)}
                    >
                      Revoke
                    </button>
                  )}
                  {d.revoked && (
                    <span style={{ color: '#f38ba8', fontSize: 12 }}>
                      Revoked
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 8px',
  color: '#a6adc8',
  fontSize: 13,
  verticalAlign: 'middle',
};

const inputStyle: React.CSSProperties = {
  background: '#181825',
  border: '1px solid #45475a',
  borderRadius: 4,
  color: '#cdd6f4',
  padding: '2px 8px',
  fontSize: 13,
  width: 140,
};

const smallBtnStyle: React.CSSProperties = {
  background: '#89b4fa',
  color: '#1e1e2e',
  border: 'none',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 12,
  cursor: 'pointer',
};

const revokeStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#f38ba8',
  border: '1px solid #f38ba8',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 12,
  cursor: 'pointer',
};
