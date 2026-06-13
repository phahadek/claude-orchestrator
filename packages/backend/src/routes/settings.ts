import { Router } from 'express';
import type { Request, Response } from 'express';
import { getAllSettings } from '../db/queries';
import { runtimeSettings } from '../config';
import {
  typedGetSetting,
  typedSetSetting,
  type SettingKey,
  type Settings,
} from '../config/settings';

let _reviewOrchestrator: { drain(): Promise<void> } | null = null;
export function setReviewOrchestrator(orch: { drain(): Promise<void> }): void {
  _reviewOrchestrator = orch;
}

const router = Router();

const SETTING_KEYS = [
  'max_concurrent_code_sessions',
  'auto_review_concurrency',
  'auto_review',
  'card_preview_lines',
  'code_session_model',
  'review_session_model',
  'session_mode',
  'auto_launch_concurrency',
  'auto_launch_poll_interval_ms',
  'session_notify_threshold_seconds',
  'session_pause_threshold_seconds',
  'session_hard_stop_window_seconds',
  'ci_poll_interval_seconds',
  'ci_poll_max_minutes',
  'max_review_iterations',
  'pr_boot_sweep_merged_lookback_days',
  'auto_archive_enabled',
  'auto_archive_grace_minutes',
  'auto_archive_sweep_interval_minutes',
  'large_task_model',
] as const satisfies readonly SettingKey[];

type RouteSettingKey = (typeof SETTING_KEYS)[number];

function applyToRuntime(key: RouteSettingKey, value: Settings[RouteSettingKey]): void {
  switch (key) {
    case 'max_concurrent_code_sessions':
      runtimeSettings.max_concurrent_code_sessions = value as number;
      break;
    case 'auto_review_concurrency':
      runtimeSettings.auto_review_concurrency = value as number;
      void _reviewOrchestrator?.drain();
      break;
    case 'auto_review':
      runtimeSettings.auto_review = value as boolean;
      break;
    case 'card_preview_lines':
      runtimeSettings.card_preview_lines = value as number;
      break;
    case 'code_session_model':
      runtimeSettings.code_session_model = value as string;
      break;
    case 'review_session_model':
      runtimeSettings.review_session_model = value as string;
      break;
    case 'session_mode':
      runtimeSettings.session_mode = value as 'cli' | 'api';
      break;
    case 'auto_launch_concurrency':
      runtimeSettings.auto_launch_concurrency = value as number;
      break;
    case 'auto_launch_poll_interval_ms':
      runtimeSettings.auto_launch_poll_interval_ms = value as number;
      break;
    case 'session_notify_threshold_seconds':
      runtimeSettings.session_notify_threshold_seconds = value as number;
      break;
    case 'session_pause_threshold_seconds':
      runtimeSettings.session_pause_threshold_seconds = value as number;
      break;
    case 'session_hard_stop_window_seconds':
      runtimeSettings.session_hard_stop_window_seconds = value as number;
      break;
    case 'ci_poll_interval_seconds':
      runtimeSettings.ci_poll_interval_seconds = value as number;
      break;
    case 'ci_poll_max_minutes':
      runtimeSettings.ci_poll_max_minutes = value as number;
      break;
    case 'max_review_iterations':
      runtimeSettings.max_review_iterations = value as number;
      break;
    case 'pr_boot_sweep_merged_lookback_days':
      runtimeSettings.pr_boot_sweep_merged_lookback_days = value as number;
      break;
    case 'auto_archive_enabled':
      runtimeSettings.auto_archive_enabled = value as boolean;
      break;
    case 'auto_archive_grace_minutes':
      runtimeSettings.auto_archive_grace_minutes = value as number;
      break;
    case 'auto_archive_sweep_interval_minutes':
      runtimeSettings.auto_archive_sweep_interval_minutes = value as number;
      break;
    case 'large_task_model':
      runtimeSettings.large_task_model = value as string;
      break;
  }
}

/** Seed runtimeSettings from DB, falling back to schema defaults for missing/malformed keys. */
export function loadRuntimeSettingsFromDb(): void {
  for (const key of SETTING_KEYS) {
    applyToRuntime(key, typedGetSetting(key));
  }
}

function runtimeSettingsAsRecord(): Record<RouteSettingKey, string> {
  return {
    max_concurrent_code_sessions: String(
      runtimeSettings.max_concurrent_code_sessions,
    ),
    auto_review_concurrency: String(runtimeSettings.auto_review_concurrency),
    auto_review: String(runtimeSettings.auto_review),
    card_preview_lines: String(runtimeSettings.card_preview_lines),
    code_session_model: runtimeSettings.code_session_model,
    review_session_model: runtimeSettings.review_session_model,
    session_mode: runtimeSettings.session_mode,
    auto_launch_concurrency: String(runtimeSettings.auto_launch_concurrency),
    auto_launch_poll_interval_ms: String(
      runtimeSettings.auto_launch_poll_interval_ms,
    ),
    session_notify_threshold_seconds: String(
      runtimeSettings.session_notify_threshold_seconds,
    ),
    session_pause_threshold_seconds: String(
      runtimeSettings.session_pause_threshold_seconds,
    ),
    session_hard_stop_window_seconds: String(
      runtimeSettings.session_hard_stop_window_seconds,
    ),
    ci_poll_interval_seconds: String(runtimeSettings.ci_poll_interval_seconds),
    ci_poll_max_minutes: String(runtimeSettings.ci_poll_max_minutes),
    max_review_iterations: String(runtimeSettings.max_review_iterations),
    pr_boot_sweep_merged_lookback_days: String(
      runtimeSettings.pr_boot_sweep_merged_lookback_days,
    ),
    auto_archive_enabled: String(runtimeSettings.auto_archive_enabled),
    auto_archive_grace_minutes: String(
      runtimeSettings.auto_archive_grace_minutes,
    ),
    auto_archive_sweep_interval_minutes: String(
      runtimeSettings.auto_archive_sweep_interval_minutes,
    ),
    large_task_model: runtimeSettings.large_task_model,
  };
}

// GET /api/settings
router.get('/', (_req: Request, res: Response) => {
  res.json(runtimeSettingsAsRecord());
});

// PATCH /api/settings — validates each value against the schema before persisting.
// Returns 400 with an error message if any value fails validation (fail-loud, no silent save).
router.patch('/', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const updated: Partial<Record<RouteSettingKey, unknown>> = {};

  for (const key of SETTING_KEYS) {
    if (key in body && body[key] !== undefined) {
      try {
        // typedSetSetting validates with Zod and throws ZodError for bad values
        const typed = typedSetSetting(key, body[key] as never);
        applyToRuntime(key, typed);
        updated[key] = typed;
      } catch (err) {
        res
          .status(400)
          .json({ error: `Invalid value for "${key}": ${(err as Error).message}` });
        return;
      }
    }
  }

  res.json({ updated, current: runtimeSettingsAsRecord() });
});

// Merge all settings from DB (used after startup to override env defaults)
router.get('/all-raw', (_req: Request, res: Response) => {
  res.json(getAllSettings());
});

export default router;
