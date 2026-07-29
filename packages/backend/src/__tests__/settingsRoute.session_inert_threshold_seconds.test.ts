import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Hoisted mock state ────────────────────────────────────────────────────────
// vi.mock factories are hoisted; variables they reference must be too.

const {
  mockRuntimeSettings,
  mockSetSetting,
  mockGetSetting,
  mockGetAllSettings,
} = vi.hoisted(() => {
  const mockRuntimeSettings = {
    max_concurrent_code_sessions: 20,
    auto_review_concurrency: 1,
    auto_review: true,
    card_preview_lines: 3,
    code_session_model: '',
    review_session_model: '',
    session_mode: 'cli' as const,
    auto_launch_concurrency: 1,
    auto_launch_poll_interval_ms: 60000,
    session_notify_threshold_seconds: 3600,
    session_pause_threshold_seconds: 7200,
    session_inert_threshold_seconds: 600,
    session_hard_stop_window_seconds: 60,
    ci_poll_interval_seconds: 30,
    ci_poll_max_minutes: 30,
    max_review_iterations: 3,
    auto_merge_failed_clear_minutes: 10,
    corporate_mode_enabled: false,
    pr_boot_sweep_merged_lookback_days: 30,
    auto_archive_enabled: true,
    auto_archive_grace_minutes: 30,
    auto_archive_sweep_interval_minutes: 5,
    large_task_model: '',
  };
  return {
    mockRuntimeSettings,
    mockSetSetting: vi.fn(),
    mockGetSetting: vi.fn((_key: string) => undefined as string | undefined),
    mockGetAllSettings: vi.fn(() => ({})),
  };
});

vi.mock('../db/queries.js', () => ({
  getSetting: (key: string) => mockGetSetting(key),
  setSetting: (key: string, value: string) => mockSetSetting(key, value),
  getAllSettings: () => mockGetAllSettings(),
}));

vi.mock('../config.js', () => ({
  runtimeSettings: mockRuntimeSettings,
}));

// Import after mocks
import settingsRouter from '../routes/settings.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', settingsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRuntimeSettings.session_inert_threshold_seconds = 600;
});

describe('session_inert_threshold_seconds setting', () => {
  it('GET reflects the default', async () => {
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.session_inert_threshold_seconds).toBe('600');
  });

  it('PATCH persists a new value', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ session_inert_threshold_seconds: 900 });

    expect(res.status).toBe(200);
    expect(res.body.current.session_inert_threshold_seconds).toBe('900');
    expect(mockRuntimeSettings.session_inert_threshold_seconds).toBe(900);
    expect(mockSetSetting).toHaveBeenCalledWith(
      'session_inert_threshold_seconds',
      '900',
    );
  });

  it('PATCH with a negative value returns 400 and does not persist', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ session_inert_threshold_seconds: -1 });

    expect(res.status).toBe(400);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });
});
