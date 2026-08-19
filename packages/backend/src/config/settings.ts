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

// Nullable percent threshold: '' (or absent) means the soft-pause is
// disabled — mirrors the empty-string-means-off convention used for the
// model/effort settings above, rather than introducing a separate null path.
const usagePauseThresholdPercent = z
  .string()
  .refine(
    (v) =>
      v === '' ||
      (Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 100),
    { message: 'Must be empty (disabled) or a number between 1 and 100' },
  );

const SettingsSchema = z.object({
  // Numeric settings (z.coerce accepts both numbers and parseable strings)
  max_concurrent_code_sessions: z.coerce.number().int().min(1),
  max_concurrent_planning_sessions: z.coerce.number().int().min(1),
  max_concurrent_verify_sessions: z.coerce.number().int().min(1),
  max_concurrent_investigate_sessions: z.coerce.number().int().min(1),
  human_reserve: z.coerce.number().int().min(0),
  auto_review_concurrency: z.coerce.number().int().min(1),
  card_preview_lines: z.coerce.number().int().min(1),
  auto_launch_concurrency: z.coerce.number().int().min(1),
  auto_launch_poll_interval_ms: z.coerce.number().int().min(100),
  hourly_usage_pause_threshold_percent: usagePauseThresholdPercent,
  weekly_usage_pause_threshold_percent: usagePauseThresholdPercent,
  min_host_free_memory_mb: z.coerce.number().int().min(0),
  per_session_reserve_mb: z.coerce.number().int().min(0),
  session_notify_threshold_seconds: z.coerce.number().int().min(0),
  session_pause_threshold_seconds: z.coerce.number().int().min(0),
  session_inert_threshold_seconds: z.coerce.number().int().min(0),
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
  test_request_max_concurrent_per_project: z.coerce.number().int().min(1),
  test_request_cycle_limit: z.coerce.number().int().min(1),
  dependency_cache_max_age_hours: z.coerce.number().int().min(1),
  dependency_cache_max_total_size_mb: z.coerce.number().int().min(1),
  session_cgroup_prod_reserve_mb: z.coerce.number().int().min(0),
  session_cgroup_memory_high_fraction: z.coerce.number().min(0).max(1),
  milestone_attention_aging_threshold_seconds: z.coerce.number().int().min(0),
  milestone_attention_flat_convergence_window_seconds: z.coerce
    .number()
    .int()
    .min(0),
  // Capped at 200 — the outcome-sequence digest on test_perf_baselines
  // (TEST_OUTCOME_DIGEST_CAPACITY, db/queries.ts) only retains the most
  // recent 200 valid outcomes per test. Every production caller passes this
  // setting straight through to computeTestFlipRateFlag as windowN; a value
  // above the digest's capacity would silently degrade flip-rate accuracy
  // (the digest simply couldn't return more samples than it retains) with
  // no error, so the bound here keeps that impossible.
  flip_rate_window_n: z.coerce.number().int().min(1).max(200),
  flip_rate_threshold_k: z.coerce.number().int().min(1),
  // Supplements flip_rate_threshold_k with a breadth-of-trees signal: a test
  // failing across this many distinct content hashes within the lookback
  // window below cannot be attributable to any single diff, so it clears
  // the same masking guard a flip-rate flag would — see
  // evaluateF2LaneFlakyDisposition (orchestration/testRequestLane.ts).
  flip_rate_breadth_n: z.coerce.number().int().min(1),
  flip_rate_breadth_window_hours: z.coerce.number().int().min(1),
  flaky_remediation_file_threshold: z.coerce.number().int().min(1),
  decision_pick_one_paragraph_threshold: z.coerce.number().int().min(100),

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
  gate_verify_session_model: z.string(),
  investigate_session_model: z.string(),
  groom_session_model: z.string(),
  design_session_model: z.string(),
  docs_session_model: z.string(),
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
  gate_verify_session_effort: z.enum([
    '',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]),
  investigate_session_effort: z.enum([
    '',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]),
  groom_session_effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']),
  design_session_effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']),
  docs_session_effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']),

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
  max_concurrent_verify_sessions: 5,
  max_concurrent_investigate_sessions: 5,
  human_reserve: 1,
  auto_review_concurrency: 20,
  card_preview_lines: 3,
  auto_launch_concurrency: 1,
  auto_launch_poll_interval_ms: 60_000,
  hourly_usage_pause_threshold_percent: '',
  weekly_usage_pause_threshold_percent: '',
  min_host_free_memory_mb: 4096,
  per_session_reserve_mb: 3072,
  session_notify_threshold_seconds: 3600,
  session_pause_threshold_seconds: 7200,
  session_inert_threshold_seconds: 600,
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
  test_request_max_concurrent_per_project: 2,
  test_request_cycle_limit: 5,
  dependency_cache_max_age_hours: 168,
  dependency_cache_max_total_size_mb: 10_240,
  session_cgroup_prod_reserve_mb: 4096,
  session_cgroup_memory_high_fraction: 0.9,
  milestone_attention_aging_threshold_seconds: 24 * 60 * 60,
  milestone_attention_flat_convergence_window_seconds: 48 * 60 * 60,
  flip_rate_window_n: 20,
  flip_rate_threshold_k: 2,
  flip_rate_breadth_n: 3,
  flip_rate_breadth_window_hours: 24,
  flaky_remediation_file_threshold: 2,
  decision_pick_one_paragraph_threshold: 560,
  auto_review: true,
  auto_archive_enabled: true,
  session_cgroup_deny_swap: true,
  code_session_model: '',
  review_session_model: '',
  large_task_model: '',
  planning_session_model: '',
  ops_session_model: '',
  gate_verify_session_model: '',
  investigate_session_model: '',
  groom_session_model: '',
  design_session_model: '',
  docs_session_model: '',
  tier3_classifier_model: 'claude-haiku-4-5-20251001',
  session_mode: 'cli',
  release_channel: 'stable',
  corporate_mode: 'personal',
  code_session_effort: '',
  review_session_effort: '',
  large_task_effort: '',
  planning_session_effort: '',
  ops_session_effort: '',
  gate_verify_session_effort: '',
  investigate_session_effort: '',
  groom_session_effort: '',
  design_session_effort: '',
  docs_session_effort: '',
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
