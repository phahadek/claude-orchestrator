export interface SettingsValues {
  max_concurrent_code_sessions: string;
  max_concurrent_planning_sessions: string;
  max_concurrent_verify_sessions: string;
  auto_review_concurrency: string;
  auto_review: string;
  card_preview_lines: string;
  code_session_model: string;
  review_session_model: string;
  code_session_effort: string;
  review_session_effort: string;
  planning_session_model: string;
  planning_session_effort: string;
  ops_session_model: string;
  ops_session_effort: string;
  gate_verify_session_model: string;
  gate_verify_session_effort: string;
  groom_session_model: string;
  groom_session_effort: string;
  design_session_model: string;
  design_session_effort: string;
  docs_session_model: string;
  docs_session_effort: string;
  session_mode: string;
  auto_launch_concurrency: string;
  auto_launch_poll_interval_ms: string;
  hourly_usage_pause_threshold_percent: string;
  weekly_usage_pause_threshold_percent: string;
  session_notify_threshold_seconds: string;
  session_pause_threshold_seconds: string;
  session_hard_stop_window_seconds: string;
  ci_poll_interval_seconds: string;
  ci_poll_max_minutes: string;
  max_review_iterations: string;
  auto_archive_enabled: string;
  auto_archive_grace_minutes: string;
  auto_archive_sweep_interval_minutes: string;
  large_task_model: string;
  large_task_effort: string;
  tier3_classifier_model: string;
  capability_auto_approve_allowlist: string[];
}

export const MIN_POLL_INTERVAL_MS = 5000;

export const MODEL_OPTIONS = [
  { label: '(CLI default)', value: '' },
  { label: 'claude-opus-4-6', value: 'claude-opus-4-6' },
  { label: 'claude-sonnet-5', value: 'claude-sonnet-5' },
  { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6' },
  { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5' },
];

export const EFFORT_OPTIONS = [
  { label: 'Default', value: '' },
  { label: 'low', value: 'low' },
  { label: 'medium', value: 'medium' },
  { label: 'high', value: 'high' },
  { label: 'xhigh', value: 'xhigh' },
  { label: 'max', value: 'max' },
];

const NON_NUMERIC_KEYS = new Set<keyof SettingsValues>([
  'code_session_model',
  'review_session_model',
  'code_session_effort',
  'review_session_effort',
  'planning_session_model',
  'planning_session_effort',
  'ops_session_model',
  'ops_session_effort',
  'gate_verify_session_model',
  'gate_verify_session_effort',
  'groom_session_model',
  'groom_session_effort',
  'design_session_model',
  'design_session_effort',
  'docs_session_model',
  'docs_session_effort',
  'session_mode',
  'large_task_model',
  'large_task_effort',
  'tier3_classifier_model',
  'auto_review',
  'auto_archive_enabled',
]);

const NULLABLE_PERCENT_KEYS = new Set<keyof SettingsValues>([
  'hourly_usage_pause_threshold_percent',
  'weekly_usage_pause_threshold_percent',
]);

export function validateField(
  key: keyof SettingsValues,
  value: string,
): string | null {
  if (NON_NUMERIC_KEYS.has(key)) return null;
  if (NULLABLE_PERCENT_KEYS.has(key)) {
    if (value === '') return null;
    const pct = Number(value);
    if (!Number.isInteger(pct) || isNaN(pct)) return 'Must be a whole number';
    if (pct < 1 || pct > 100) return 'Must be between 1 and 100';
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || isNaN(num)) return 'Must be a whole number';
  if (key === 'auto_launch_concurrency' && num < 1) return 'Minimum is 1';
  if (key === 'max_review_iterations' && num < 1) return 'Minimum is 1';
  if (key === 'max_concurrent_verify_sessions' && num < 1)
    return 'Minimum is 1';
  if (key === 'auto_launch_poll_interval_ms' && num < MIN_POLL_INTERVAL_MS)
    return `Minimum is ${MIN_POLL_INTERVAL_MS} ms`;
  return null;
}
