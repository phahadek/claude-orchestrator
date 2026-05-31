import { useState, useEffect, useCallback } from 'react';
import { ProjectsSettingsPanel } from './Settings/ProjectsSettingsPanel';
import { SettingsDevices } from '../pages/SettingsDevices';
import styles from './Settings.module.css';

const NOTIFICATIONS_ENABLED_KEY = 'notificationsEnabled';

type Tab = 'general' | 'projects' | 'devices';

interface SettingsValues {
  max_concurrent_code_sessions: string;
  auto_review_concurrency: string;
  auto_review: string;
  card_preview_lines: string;
  code_session_model: string;
  review_session_model: string;
  session_mode: string;
  auto_launch_concurrency: string;
  auto_launch_poll_interval_ms: string;
  session_notify_threshold_seconds: string;
  session_pause_threshold_seconds: string;
  session_hard_stop_window_seconds: string;
  ci_poll_interval_seconds: string;
  ci_poll_max_minutes: string;
  max_review_iterations: string;
}

const MIN_POLL_INTERVAL_MS = 5000;

function validateField(
  key: keyof SettingsValues,
  value: string,
): string | null {
  const num = Number(value);
  if (!Number.isInteger(num) || isNaN(num)) return 'Must be a whole number';
  if (key === 'auto_launch_concurrency' && num < 1) return 'Minimum is 1';
  if (key === 'max_review_iterations' && num < 1) return 'Minimum is 1';
  if (key === 'auto_launch_poll_interval_ms' && num < MIN_POLL_INTERVAL_MS)
    return `Minimum is ${MIN_POLL_INTERVAL_MS} ms`;
  return null;
}

const MODEL_OPTIONS = [
  { label: '(CLI default)', value: '' },
  { label: 'claude-opus-4-6', value: 'claude-opus-4-6' },
  { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6' },
  { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5' },
];

interface Props {
  initialTab?: Tab;
  onProjectsChanged?: () => void;
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

export function Settings({ initialTab = 'general', onProjectsChanged }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [settings, setSettings] = useState<SettingsValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<string | null>(
    null,
  );
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof SettingsValues, string>>
  >({});
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(
    () => localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) !== 'false',
  );
  const notificationPermission =
    typeof Notification !== 'undefined' ? Notification.permission : 'default';

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

    const error = validateField(key, value);
    if (error) {
      setFieldErrors((prev) => ({ ...prev, [key]: error }));
      return;
    }
    setFieldErrors((prev) => {
      const e = { ...prev };
      delete e[key];
      return e;
    });
    setSaveError(null);
    try {
      await patchSettings({ [key]: value });
    } catch {
      setSaveError('Failed to save setting');
    }
  }

  function numInput(
    key: keyof SettingsValues,
    label: string,
    min = 0,
    max = 999,
    step = 1,
    hint?: string,
  ) {
    const val = Number(settings?.[key] ?? 0);
    const fieldError = fieldErrors[key];
    return (
      <div key={key}>
        <div className={styles.field}>
          <label className={styles.label}>
            {label}
            {hint && <span className={styles.hint}> — {hint}</span>}
          </label>
          <div className={styles.numControl}>
            <button
              type="button"
              className={styles.stepBtn}
              onClick={() =>
                handleChange(key, String(Math.max(min, val - step)))
              }
              disabled={val <= min}
            >
              −
            </button>
            <input
              type="number"
              className={`${styles.numInput}${fieldError ? ` ${styles.numInputError}` : ''}`}
              value={val}
              min={min}
              max={max}
              step={step}
              onChange={(e) => handleChange(key, e.target.value)}
            />
            <button
              type="button"
              className={styles.stepBtn}
              onClick={() =>
                handleChange(key, String(Math.min(max, val + step)))
              }
              disabled={val >= max}
            >
              +
            </button>
          </div>
        </div>
        {fieldError && <p className={styles.fieldError}>{fieldError}</p>}
      </div>
    );
  }

  const handleCheckUpdate = useCallback(async () => {
    setCheckingUpdate(true);
    setUpdateCheckResult(null);
    try {
      const res = await fetch('/api/update/check', { method: 'POST' });
      const body = (await res.json()) as {
        updateAvailable?: boolean;
        info?: { version: string };
      };
      if (body.updateAvailable && body.info) {
        setUpdateCheckResult(`Update available: ${body.info.version}`);
      } else {
        setUpdateCheckResult('You are on the latest version.');
      }
    } catch {
      setUpdateCheckResult('Failed to check for updates.');
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  return (
    <div className={styles.settings}>
      <div className={styles.tabs}>
        {(['general', 'projects', 'devices'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.tab}${activeTab === t ? ` ${styles.tabActive}` : ''}`}
            onClick={() => setActiveTab(t)}
          >
            {t === 'general'
              ? 'General'
              : t === 'projects'
                ? 'Projects'
                : 'Devices'}
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
                {numInput(
                  'max_concurrent_code_sessions',
                  'Max concurrent code sessions',
                  1,
                  100,
                )}
                {numInput(
                  'auto_review_concurrency',
                  'Max concurrent review sessions',
                  1,
                  20,
                )}

                <h3 className={styles.sectionTitle}>Display</h3>
                {numInput(
                  'card_preview_lines',
                  'Session card preview lines',
                  1,
                  10,
                )}

                <h3 className={styles.sectionTitle}>Auto-review</h3>
                {numInput(
                  'max_review_iterations',
                  'Max review iterations',
                  1,
                  20,
                )}
                <div className={styles.field}>
                  <label className={styles.label}>Enable auto-review</label>
                  <button
                    type="button"
                    className={`${styles.toggle}${settings?.auto_review === 'true' ? ` ${styles.toggleOn}` : ''}`}
                    onClick={() =>
                      handleChange(
                        'auto_review',
                        settings?.auto_review === 'true' ? 'false' : 'true',
                      )
                    }
                  >
                    {settings?.auto_review === 'true' ? 'On' : 'Off'}
                  </button>
                </div>

                <h3 className={styles.sectionTitle}>Session Mode</h3>
                <div className={styles.field}>
                  <label className={styles.label}>
                    Session launch mode
                    <span className={styles.hint}>
                      {' '}
                      (cli = subprocess, api = Agent SDK)
                    </span>
                  </label>
                  <button
                    type="button"
                    className={`${styles.toggle}${settings?.session_mode === 'api' ? ` ${styles.toggleOn}` : ''}`}
                    onClick={() =>
                      handleChange(
                        'session_mode',
                        settings?.session_mode === 'api' ? 'cli' : 'api',
                      )
                    }
                  >
                    {settings?.session_mode === 'api' ? 'API' : 'CLI'}
                  </button>
                </div>
                {settings?.session_mode === 'api' && (
                  <p className={styles.hint}>
                    API mode requires <code>ANTHROPIC_API_KEY</code> in the
                    backend environment. Sessions run via the Agent SDK; cost is
                    billed per token.
                  </p>
                )}

                <h3 className={styles.sectionTitle}>Models</h3>
                <div className={styles.field}>
                  <label className={styles.label}>Code session model</label>
                  <select
                    className={styles.select}
                    value={settings?.code_session_model ?? ''}
                    onChange={(e) =>
                      void handleChange('code_session_model', e.target.value)
                    }
                  >
                    {MODEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Review session model</label>
                  <select
                    className={styles.select}
                    value={settings?.review_session_model ?? ''}
                    onChange={(e) =>
                      void handleChange('review_session_model', e.target.value)
                    }
                  >
                    {MODEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <h3 className={styles.sectionTitle}>Stuck-session Timer</h3>
                <p className={styles.hint}>
                  Wall-clock thresholds (in seconds) measured since the later of
                  session start and last review event. Set to 0 to disable.
                </p>
                {numInput(
                  'session_notify_threshold_seconds',
                  'Notify threshold (seconds)',
                  0,
                  86400,
                  60,
                )}
                {numInput(
                  'session_pause_threshold_seconds',
                  'Pause threshold (seconds)',
                  0,
                  86400,
                  60,
                )}
                {numInput(
                  'session_hard_stop_window_seconds',
                  'Hard-stop window after pause (seconds)',
                  0,
                  3600,
                  10,
                )}

                <h3 className={styles.sectionTitle}>Auto-launch</h3>
                <p className={styles.hint}>
                  Controls how the orchestrator picks up and launches Ready
                  tasks automatically.
                </p>
                {numInput(
                  'auto_launch_concurrency',
                  'Auto-launch concurrency cap',
                  1,
                  100,
                  1,
                  'How many coding sessions may run in parallel',
                )}
                {numInput(
                  'auto_launch_poll_interval_ms',
                  'Auto-launch poll interval (ms)',
                  MIN_POLL_INTERVAL_MS,
                  3600000,
                  1000,
                  'How often AutoLauncher checks for new Ready tasks',
                )}

                <h3 className={styles.sectionTitle}>Auto-merge</h3>
                <p className={styles.hint}>
                  After auto-review approves a PR, the orchestrator polls CI
                  status. When CI turns green, it squash-merges to dev
                  (per-project opt-in under Projects → Edit).
                </p>
                {numInput(
                  'ci_poll_interval_seconds',
                  'CI poll interval (seconds)',
                  5,
                  600,
                  5,
                )}
                {numInput(
                  'ci_poll_max_minutes',
                  'CI poll max wait (minutes)',
                  1,
                  240,
                  1,
                )}

                <h3 className={styles.sectionTitle}>About</h3>
                <div className={styles.field}>
                  <label className={styles.label}>Check for updates</label>
                  <button
                    type="button"
                    className={styles.toggle}
                    onClick={() => void handleCheckUpdate()}
                    disabled={checkingUpdate}
                  >
                    {checkingUpdate ? 'Checking…' : 'Check now'}
                  </button>
                </div>
                {updateCheckResult && (
                  <p className={styles.hint}>{updateCheckResult}</p>
                )}

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
                      localStorage.setItem(
                        NOTIFICATIONS_ENABLED_KEY,
                        String(next),
                      );
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
            <ProjectsSettingsPanel onProjectsChanged={onProjectsChanged} />
          </div>
        )}

        {activeTab === 'devices' && (
          <div className={styles.section}>
            <SettingsDevices />
          </div>
        )}
      </div>
    </div>
  );
}
