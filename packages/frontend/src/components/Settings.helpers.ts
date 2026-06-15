export interface SettingsValues {
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
  auto_archive_enabled: string;
  auto_archive_grace_minutes: string;
  auto_archive_sweep_interval_minutes: string;
  large_task_model: string;
}

export const MIN_POLL_INTERVAL_MS = 5000;

const NON_NUMERIC_KEYS = new Set<keyof SettingsValues>([
  'code_session_model',
  'review_session_model',
  'session_mode',
  'large_task_model',
  'auto_review',
  'auto_archive_enabled',
]);

export function validateField(
  key: keyof SettingsValues,
  value: string,
): string | null {
  if (NON_NUMERIC_KEYS.has(key)) return null;
  const num = Number(value);
  if (!Number.isInteger(num) || isNaN(num)) return 'Must be a whole number';
  if (key === 'auto_launch_concurrency' && num < 1) return 'Minimum is 1';
  if (key === 'max_review_iterations' && num < 1) return 'Minimum is 1';
  if (key === 'auto_launch_poll_interval_ms' && num < MIN_POLL_INTERVAL_MS)
    return `Minimum is ${MIN_POLL_INTERVAL_MS} ms`;
  return null;
}
