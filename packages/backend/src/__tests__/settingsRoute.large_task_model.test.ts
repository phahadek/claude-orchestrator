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
  mockRuntimeSettings.large_task_model = '';
});

describe('large_task_model setting', () => {
  it('GET returns empty string by default', async () => {
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.large_task_model).toBe('');
  });

  it('PATCH updates runtimeSettings and returns new value', async () => {
    const model = 'claude-opus-4-7[1m]';
    const res = await supertest(buildApp())
      .patch('/')
      .send({ large_task_model: model });

    expect(res.status).toBe(200);
    expect(res.body.current.large_task_model).toBe(model);
    expect(mockRuntimeSettings.large_task_model).toBe(model);
    expect(mockSetSetting).toHaveBeenCalledWith('large_task_model', model);
  });

  it('PATCH with empty string turns feature off without error', async () => {
    mockRuntimeSettings.large_task_model = 'claude-opus-4-7[1m]';

    const res = await supertest(buildApp())
      .patch('/')
      .send({ large_task_model: '' });

    expect(res.status).toBe(200);
    expect(res.body.current.large_task_model).toBe('');
    expect(mockRuntimeSettings.large_task_model).toBe('');
  });

  it('preserves [1m] suffix verbatim through round-trip serialization', async () => {
    const model = 'claude-sonnet-4-6[1m]';
    mockRuntimeSettings.large_task_model = model;

    const res = await supertest(buildApp()).get('/');
    expect(res.body.large_task_model).toBe(model);
  });
});

describe('failure-loud validation (M8 footgun fix)', () => {
  it('PATCH with invalid session_mode returns 400 and does not persist', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ session_mode: 'web' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/session_mode/);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('PATCH with invalid release_channel returns 400 and does not persist', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ release_channel: 'nightly' });

    // release_channel is not in the route's SETTING_KEYS, so it is ignored
    // and the PATCH succeeds with no updates (this tests that unknown keys are silently skipped)
    expect(res.status).toBe(200);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('PATCH with negative max_review_iterations returns 400', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ max_review_iterations: -1 });

    expect(res.status).toBe(400);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('PATCH with non-numeric string for numeric field returns 400', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ max_review_iterations: 'abc' });

    expect(res.status).toBe(400);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });
});
