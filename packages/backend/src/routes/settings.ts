import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSetting, setSetting, getAllSettings } from '../db/queries';
import { runtimeSettings } from '../config';

const router = Router();

const SETTING_KEYS = [
  'max_concurrent_sessions',
  'auto_review_concurrency',
  'auto_review',
  'plan_tier',
  'plan_token_cap',
  'card_preview_lines',
  'code_session_model',
  'review_session_model',
] as const;

const PLAN_TIER_CAPS: Record<string, number> = {
  'Free': 0,
  'Pro': 5_000_000,
  'Team': 5_000_000,
  'Max (5x)': 25_000_000,
  'Max (20x)': 100_000_000,
};

type SettingKey = (typeof SETTING_KEYS)[number];

function applyToRuntime(key: SettingKey, value: string): void {
  if (key === 'max_concurrent_sessions') {
    runtimeSettings.max_concurrent_sessions = Number(value);
  } else if (key === 'auto_review_concurrency') {
    runtimeSettings.auto_review_concurrency = Number(value);
  } else if (key === 'auto_review') {
    runtimeSettings.auto_review = value !== 'false';
  } else if (key === 'plan_tier') {
    runtimeSettings.plan_tier = value;
    if (value in PLAN_TIER_CAPS) {
      runtimeSettings.plan_token_cap = PLAN_TIER_CAPS[value];
    }
  } else if (key === 'plan_token_cap') {
    runtimeSettings.plan_token_cap = Number(value);
  } else if (key === 'card_preview_lines') {
    runtimeSettings.card_preview_lines = Number(value);
  } else if (key === 'code_session_model') {
    runtimeSettings.code_session_model = value;
  } else if (key === 'review_session_model') {
    runtimeSettings.review_session_model = value;
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
      if (key === 'auto_review') {
        defaultVal = String(runtimeSettings.auto_review);
      } else if (key === 'plan_tier' || key === 'code_session_model' || key === 'review_session_model') {
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
    max_concurrent_sessions: String(runtimeSettings.max_concurrent_sessions),
    auto_review_concurrency: String(runtimeSettings.auto_review_concurrency),
    auto_review: String(runtimeSettings.auto_review),
    plan_tier: runtimeSettings.plan_tier,
    plan_token_cap: String(runtimeSettings.plan_token_cap),
    card_preview_lines: String(runtimeSettings.card_preview_lines),
    code_session_model: runtimeSettings.code_session_model,
    review_session_model: runtimeSettings.review_session_model,
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
      // When a known tier is set, also persist the resolved cap
      if (key === 'plan_tier' && value in PLAN_TIER_CAPS) {
        const resolvedCap = String(PLAN_TIER_CAPS[value]);
        setSetting('plan_token_cap', resolvedCap);
        updated['plan_token_cap'] = resolvedCap;
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
