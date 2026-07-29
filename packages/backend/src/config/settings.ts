import { z } from 'zod';
import {
  getSetting as rawGetSetting,
  setSetting as rawSetSetting,
} from '../db/queries';

const zodBoolCoerce = z.union([
  z.boolean(),
  z.literal('true').transform((): true => true),
  z.literal('false').transform((): false => false),
]);

const SettingsSchema = z.object({
  // Numeric settings (z.coerce accepts both numbers and parseable strings)
  max_concurrent_code_sessions: z.coerce.number().int().min(1),
  max_concurrent_planning_sessions: z.coerce.number().int().min(1),
  auto_review_concurrency: z.coerce.number().int().min(1),
  card_preview_lines: z.coerce.number().int().min(1),
  auto_launch_concurrency: z.coerce.number().int().min(1),
  auto_launch_poll_interval_ms: z.coerce.number().int().min(100),
  min_host_free_memory_mb: z.coerce.number().int().min(0),
  per_session_reserve_mb: z.coerce.number().int().min(0),
  session_notify_threshold_seconds: z.coerce.number().int().min(0),
  session_pause_threshold_seconds: z.coerce.number().int().min(0),
  session_hard_stop_window_seconds: z.coerce.number().int().min(0),
  ci_poll_interval_seconds: z.coerce.number().int().min(1),
  ci_poll_max_minutes: z.coerce.number().int().min(1),
  max_review_iterations: z.coerce.number().int().min(1),
  pr_boot_sweep_merged_lookback_days: z.coerce.number().int().min(0),
  auto_archive_grace_minutes: z.coerce.number().int().min(0),
  auto_archive_sweep_interval_minutes: z.coerce.number().int().min(1),
  reviewer_comment_quiescence_ms: z.coerce.number().int().min(0),
  session_pr_close_grace_minutes: z.coerce.number().int().min(0),
  flake_recovery_max_retries: z.coerce.number().int().min(0),
  session_cgroup_prod_reserve_mb: z.coerce.number().int().min(0),
  session_cgroup_memory_high_fraction: z.coerce.number().min(0).max(1),

  // Boolean settings (stored as 'true'/'false' strings; also accepts native booleans)
  auto_review: zodBoolCoerce,
  auto_archive_enabled: zodBoolCoerce,
  session_cgroup_deny_swap: zodBoolCoerce,

  // Free-form string settings (model names, empty string = feature off)
  code_session_model: z.string(),
  review_session_model: z.string(),
  large_task_model: z.string(),
  planning_session_model: z.string(),
  ops_session_model: z.string(),
  tier3_classifier_model: z.string(),

  // Enum settings — only accepted values are valid
  session_mode: z.enum(['cli', 'api']),
  release_channel: z.enum(['stable', 'beta']),
  corporate_mode: z.enum(['corporate', 'personal']),
  code_session_effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']),
  review_session_effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']),
  large_task_effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']),
  planning_session_effort: z.enum([
    '',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]),
  ops_session_effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']),

  // JSON-serialised string arrays
  ai_reviewer_usernames: z.array(z.string()),
  bot_comment_deny_list: z.array(z.string()),
  bot_comment_allow_list: z.array(z.string()),
  capability_auto_approve_allowlist: z.array(z.string()),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingKey = keyof Settings;

export const SETTING_DEFAULTS: Settings = {
  max_concurrent_code_sessions: 20,
  max_concurrent_planning_sessions: 5,
  auto_review_concurrency: 20,
  card_preview_lines: 3,
  auto_launch_concurrency: 1,
  auto_launch_poll_interval_ms: 60_000,
  min_host_free_memory_mb: 4096,
  per_session_reserve_mb: 3072,
  session_notify_threshold_seconds: 3600,
  session_pause_threshold_seconds: 7200,
  session_hard_stop_window_seconds: 60,
  ci_poll_interval_seconds: 30,
  ci_poll_max_minutes: 30,
  max_review_iterations: 3,
  pr_boot_sweep_merged_lookback_days: 30,
  auto_archive_grace_minutes: 30,
  auto_archive_sweep_interval_minutes: 5,
  reviewer_comment_quiescence_ms: 120_000,
  session_pr_close_grace_minutes: 5,
  flake_recovery_max_retries: 2,
  session_cgroup_prod_reserve_mb: 4096,
  session_cgroup_memory_high_fraction: 0.9,
  auto_review: true,
  auto_archive_enabled: true,
  session_cgroup_deny_swap: true,
  code_session_model: '',
  review_session_model: '',
  large_task_model: '',
  planning_session_model: '',
  ops_session_model: '',
  tier3_classifier_model: 'claude-haiku-4-5-20251001',
  session_mode: 'cli',
  release_channel: 'stable',
  corporate_mode: 'personal',
  code_session_effort: '',
  review_session_effort: '',
  large_task_effort: '',
  planning_session_effort: '',
  ops_session_effort: '',
  ai_reviewer_usernames: [],
  bot_comment_deny_list: [],
  bot_comment_allow_list: [],
  capability_auto_approve_allowlist: [],
};

function deserializeField<K extends SettingKey>(
  key: K,
  raw: string,
): Settings[K] | null {
  let input: unknown = raw;
  if (Array.isArray(SETTING_DEFAULTS[key])) {
    try {
      input = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const field = SettingsSchema.shape[key] as z.ZodTypeAny;
  const result = field.safeParse(input);
  if (result.success) return result.data as Settings[K];
  return null;
}

function serializeSetting<K extends SettingKey>(
  _key: K,
  value: Settings[K],
): string {
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

/**
 * Read a typed setting from the DB. Returns the declared default when the key
 * is absent or the stored string fails schema validation (logs a warning).
 */
export function typedGetSetting<K extends SettingKey>(key: K): Settings[K] {
  const raw = rawGetSetting(key);
  if (raw == null) {
    return SETTING_DEFAULTS[key];
  }
  const parsed = deserializeField(key, raw);
  if (parsed === null) {
    console.warn(
      `[settings] Malformed value for "${key}": ${JSON.stringify(raw)} — using default`,
    );
    return SETTING_DEFAULTS[key];
  }
  return parsed;
}

/**
 * Validate a typed value against the schema, then persist it as a TEXT string.
 * Throws ZodError immediately for non-conforming values (wrong type / out-of-enum).
 * Returns the validated typed value so callers can apply it to runtime state.
 */
export function typedSetSetting<K extends SettingKey>(
  key: K,
  value: Settings[K],
): Settings[K] {
  const parsed = (SettingsSchema.shape[key] as z.ZodTypeAny).parse(
    value,
  ) as Settings[K];
  rawSetSetting(key, serializeSetting(key, parsed));
  return parsed;
}
