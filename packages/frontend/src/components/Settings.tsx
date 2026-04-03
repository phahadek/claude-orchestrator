import { useState, useEffect } from 'react';
import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
import styles from './Settings.module.css';

const NOTIFICATIONS_ENABLED_KEY = 'notificationsEnabled';

type Tab = 'general' | 'projects';

interface SettingsValues {
  max_concurrent_code_sessions: string;
  auto_review_concurrency: string;
  auto_review: string;
  card_preview_lines: string;
  code_session_model: string;
  review_session_model: string;
  session_mode: string;
}

const MODEL_OPTIONS = [
  { label: '(CLI default)', value: '' },
  { label: 'claude-opus-4-6', value: 'claude-opus-4-6' },
  { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6' },
  { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5' },
];

interface Props {
  initialTab?: Tab;
  projects: ProjectConfig[];
}

async function fetchSettings(): Promise<SettingsValues> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<SettingsValues>;
}

async function patchSettings(patch: Partial<SettingsValues>): Promise<void> {
  const res = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

export function Settings({ initialTab = 'general', projects }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [settings, setSettings] = useState<SettingsValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(
    () => localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) !== 'false',
  );
  const notificationPermission = typeof Notification !== 'undefined' ? Notification.permission : 'default';

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    fetchSettings()
      .then((s) => setSettings(s))
      .catch(() => setSaveError('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  async function handleChange(key: keyof SettingsValues, value: string) {
    if (!settings) return;
    const next = { ...settings, [key]: value };
    setSettings(next);
    setSaveError(null);
    try {
      await patchSettings({ [key]: value });
    } catch {
      setSaveError('Failed to save setting');
    }
  }

  function numInput(key: keyof SettingsValues, label: string, min = 0, max = 999) {
    const val = Number(settings?.[key] ?? 0);
    return (
      <div className={styles.field}>
        <label className={styles.label}>{label}</label>
        <div className={styles.numControl}>
          <button
            type="button"
            className={styles.stepBtn}
            onClick={() => handleChange(key, String(Math.max(min, val - 1)))}
            disabled={val <= min}
          >−</button>
          <input
            type="number"
            className={styles.numInput}
            value={val}
            min={min}
            max={max}
            onChange={(e) => handleChange(key, e.target.value)}
          />
          <button
            type="button"
            className={styles.stepBtn}
            onClick={() => handleChange(key, String(Math.min(max, val + 1)))}
            disabled={val >= max}
          >+</button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.settings}>
      <div className={styles.tabs}>
        {(['general', 'projects'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.tab}${activeTab === t ? ` ${styles.tabActive}` : ''}`}
            onClick={() => setActiveTab(t)}
          >
            {t === 'general' ? 'General' : 'Projects'}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        {activeTab === 'general' && (
          <div className={styles.section}>
            {loading ? (
              <p className={styles.muted}>Loading…</p>
            ) : (
              <>
                {saveError && <p className={styles.error}>{saveError}</p>}

                <h3 className={styles.sectionTitle}>Session Limits</h3>
                {numInput('max_concurrent_code_sessions', 'Max concurrent code sessions', 1, 100)}
                {numInput('auto_review_concurrency', 'Max concurrent review sessions', 1, 20)}

                <h3 className={styles.sectionTitle}>Display</h3>
                {numInput('card_preview_lines', 'Session card preview lines', 1, 10)}

                <h3 className={styles.sectionTitle}>Auto-review</h3>
                <div className={styles.field}>
                  <label className={styles.label}>Enable auto-review</label>
                  <button
                    type="button"
                    className={`${styles.toggle}${settings?.auto_review === 'true' ? ` ${styles.toggleOn}` : ''}`}
                    onClick={() =>
                      handleChange('auto_review', settings?.auto_review === 'true' ? 'false' : 'true')
                    }
                  >
                    {settings?.auto_review === 'true' ? 'On' : 'Off'}
                  </button>
                </div>

                <h3 className={styles.sectionTitle}>Session Mode</h3>
                <div className={styles.field}>
                  <label className={styles.label}>
                    Session launch mode
                    <span className={styles.hint}> (cli = subprocess, api = Agent SDK)</span>
                  </label>
                  <button
                    type="button"
                    className={`${styles.toggle}${settings?.session_mode === 'api' ? ` ${styles.toggleOn}` : ''}`}
                    onClick={() =>
                      handleChange('session_mode', settings?.session_mode === 'api' ? 'cli' : 'api')
                    }
                  >
                    {settings?.session_mode === 'api' ? 'API' : 'CLI'}
                  </button>
                </div>
                {settings?.session_mode === 'api' && (
                  <p className={styles.hint}>
                    API mode requires <code>ANTHROPIC_API_KEY</code> in the backend environment.
                    Sessions run via the Agent SDK; cost is billed per token.
                  </p>
                )}

                <h3 className={styles.sectionTitle}>Models</h3>
                <div className={styles.field}>
                  <label className={styles.label}>Code session model</label>
                  <select
                    className={styles.select}
                    value={settings?.code_session_model ?? ''}
                    onChange={(e) => void handleChange('code_session_model', e.target.value)}
                  >
                    {MODEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Review session model</label>
                  <select
                    className={styles.select}
                    value={settings?.review_session_model ?? ''}
                    onChange={(e) => void handleChange('review_session_model', e.target.value)}
                  >
                    {MODEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                <h3 className={styles.sectionTitle}>Notifications</h3>
                <div className={styles.field}>
                  <label className={styles.label}>
                    🔔 Notifications
                    {notificationPermission === 'denied' && (
                      <span className={styles.hint}> (blocked by browser)</span>
                    )}
                  </label>
                  <button
                    type="button"
                    className={`${styles.toggle}${notificationsEnabled ? ` ${styles.toggleOn}` : ''}`}
                    disabled={notificationPermission === 'denied'}
                    onClick={() => {
                      const next = !notificationsEnabled;
                      localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, String(next));
                      setNotificationsEnabled(next);
                    }}
                  >
                    {notificationsEnabled ? 'On' : 'Off'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'projects' && (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Configured Projects</h3>
            <p className={styles.hint}>Projects are configured via the PROJECTS env variable. Add/remove in M3.</p>
            {projects.length === 0 ? (
              <p className={styles.muted}>No projects configured.</p>
            ) : (
              <table className={styles.projectTable}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Project Dir</th>
                    <th>Board ID</th>
                    <th>GitHub Repo</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td className={styles.mono}>{p.projectDir}</td>
                      <td className={styles.mono}>{p.boardId}</td>
                      <td className={styles.mono}>{p.githubRepo ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
