import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSetting, setSetting, getAllSettings } from '../db/queries';
import { runtimeSettings } from '../config';

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
] as const;

type SettingKey = (typeof SETTING_KEYS)[number];

function applyToRuntime(key: SettingKey, value: string): void {
  if (key === 'max_concurrent_code_sessions') {
    runtimeSettings.max_concurrent_code_sessions = Number(value);
  } else if (key === 'auto_review_concurrency') {
    runtimeSettings.auto_review_concurrency = Number(value);
  } else if (key === 'auto_review') {
    runtimeSettings.auto_review = value !== 'false';
  } else if (key === 'card_preview_lines') {
    runtimeSettings.card_preview_lines = Number(value);
  } else if (key === 'code_session_model') {
    runtimeSettings.code_session_model = value;
  } else if (key === 'review_session_model') {
    runtimeSettings.review_session_model = value;
  } else if (key === 'session_mode') {
    runtimeSettings.session_mode = value === 'api' ? 'api' : 'cli';
  } else if (key === 'auto_launch_concurrency') {
    runtimeSettings.auto_launch_concurrency = Number(value);
  } else if (key === 'auto_launch_poll_interval_ms') {
    runtimeSettings.auto_launch_poll_interval_ms = Number(value);
  } else if (key === 'session_notify_threshold_seconds') {
    runtimeSettings.session_notify_threshold_seconds = Number(value);
  } else if (key === 'session_pause_threshold_seconds') {
    runtimeSettings.session_pause_threshold_seconds = Number(value);
  } else if (key === 'session_hard_stop_window_seconds') {
    runtimeSettings.session_hard_stop_window_seconds = Number(value);
  } else if (key === 'ci_poll_interval_seconds') {
    runtimeSettings.ci_poll_interval_seconds = Number(value);
  } else if (key === 'ci_poll_max_minutes') {
    runtimeSettings.ci_poll_max_minutes = Number(value);
  } else if (key === 'max_review_iterations') {
    runtimeSettings.max_review_iterations = Number(value);
  } else if (key === 'pr_boot_sweep_merged_lookback_days') {
    runtimeSettings.pr_boot_sweep_merged_lookback_days = Number(value);
  } else if (key === 'auto_archive_enabled') {
    runtimeSettings.auto_archive_enabled = value !== 'false';
  } else if (key === 'auto_archive_grace_minutes') {
    runtimeSettings.auto_archive_grace_minutes = Number(value);
  } else if (key === 'auto_archive_sweep_interval_minutes') {
    runtimeSettings.auto_archive_sweep_interval_minutes = Number(value);
  }
}

/** Seed runtimeSettings from DB, falling back to current (env-seeded) values. */
export function loadRuntimeSettingsFromDb(): void {
  for (const key of SETTING_KEYS) {
    const stored = getSetting(key);
    if (stored !== undefined) {
      applyToRuntime(key, stored);
    } else {
      // Persist the env-seeded default so future reads are consistent
      let defaultVal: string;
      if (key === 'auto_review' || key === 'auto_archive_enabled') {
        defaultVal = String(runtimeSettings[key]);
      } else if (
        key === 'code_session_model' ||
        key === 'review_session_model' ||
        key === 'session_mode'
      ) {
        defaultVal = runtimeSettings[key];
      } else {
        defaultVal = String(runtimeSettings[key]);
      }
      setSetting(key, defaultVal);
    }
  }
}

function runtimeSettingsAsRecord(): Record<SettingKey, string> {
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
    auto_archive_grace_minutes: String(runtimeSettings.auto_archive_grace_minutes),
    auto_archive_sweep_interval_minutes: String(
      runtimeSettings.auto_archive_sweep_interval_minutes,
    ),
  };
}

// GET /api/settings
router.get('/', (_req: Request, res: Response) => {
  res.json(runtimeSettingsAsRecord());
});

// PATCH /api/settings
router.patch('/', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const updated: Partial<Record<SettingKey, string>> = {};

  for (const key of SETTING_KEYS) {
    if (key in body && body[key] !== undefined) {
      const value = String(body[key]);
      setSetting(key, value);
      applyToRuntime(key, value);
      updated[key] = value;
    }
  }

  res.json({ updated, current: runtimeSettingsAsRecord() });
});

// Merge all settings from DB (used after startup to override env defaults)
router.get('/all-raw', (_req: Request, res: Response) => {
  res.json(getAllSettings());
});

export default router;
