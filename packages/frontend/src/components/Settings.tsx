import { useState, useEffect } from 'react';
import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
import { PermissionRules } from './PermissionRules';
import styles from './Settings.module.css';

type Tab = 'general' | 'projects' | 'rules';

interface SettingsValues {
  max_concurrent_sessions: string;
  auto_review_concurrency: string;
  auto_review: string;
  plan_token_cap: string;
  card_preview_lines: string;
}

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
        {(['general', 'projects', 'rules'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.tab}${activeTab === t ? ` ${styles.tabActive}` : ''}`}
            onClick={() => setActiveTab(t)}
          >
            {t === 'general' ? 'General' : t === 'projects' ? 'Projects' : 'Permission Rules'}
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
                {numInput('max_concurrent_sessions', 'Max concurrent code sessions', 1, 100)}
                {numInput('auto_review_concurrency', 'Max concurrent review sessions', 1, 20)}

                <h3 className={styles.sectionTitle}>Token Usage</h3>
                {numInput('plan_token_cap', 'Plan token cap (0 = unset)', 0, 10_000_000)}
                <p className={styles.hint}>
                  Used to compute % of plan utilisation. Set to the monthly token budget on your Claude plan.
                </p>

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

        {activeTab === 'rules' && (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Permission Rules</h3>
            <p className={styles.hint}>Rules are evaluated in order. First match wins.</p>
            <PermissionRules />
          </div>
        )}
      </div>
    </div>
  );
}
