import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { logger } from '../logger';
import { resolveClaudePath } from '../config';
import { claudeCredentialsPath } from '../config/credentialsPath';
import { hasAuthParkedSession } from '../db/queries';
import { isAuthFailureEvent } from '../session/eventKind';
import type { Scheduler } from './Scheduler';
import { clearAuthLapse, getAuthLapse } from './authAdmission';

const PROBE_BACKOFF_BASE_MS = 60_000;
const PROBE_BACKOFF_CAP_MS = 30 * 60_000;
const PROBE_TICK_MS = 15_000;
const PROBE_TIMEOUT_MS = 90_000;
const PROBE_ARGS = [
  '-p',
  'ok',
  '--model',
  'claude-haiku-4-5-20251001',
  '--output-format',
  'json',
  '--no-session-persistence',
  '--tools',
  '',
];

type ProbeOutcome = 'success' | 'auth_failure' | 'other_failure';

interface ProbeExecResult {
  exitCode: number | null;
  stdout: string;
}

type ProbeExec = () => Promise<ProbeExecResult>;

function defaultExec(): Promise<ProbeExecResult> {
  return new Promise((resolve) => {
    execFile(
      resolveClaudePath(),
      PROBE_ARGS,
      { cwd: os.tmpdir(), timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => {
        const code =
          err == null
            ? 0
            : typeof (err as { code?: unknown }).code === 'number'
              ? ((err as { code: number }).code as number)
              : null;
        resolve({ exitCode: code, stdout: String(stdout ?? '') });
      },
    );
  });
}

/** Success = exit 0 with a JSON result that is not an error; auth failures use the shared classifier. */
function classifyProbeResult(r: ProbeExecResult): ProbeOutcome {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(r.stdout);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }
  if (r.exitCode === 0 && parsed && parsed.is_error !== true) {
    return 'success';
  }
  if (parsed && isAuthFailureEvent({ ...parsed, type: 'result' })) {
    return 'auth_failure';
  }
  return 'other_failure';
}

function backoffDelayMs(consecutiveFailures: number): number {
  const exp = Math.max(0, consecutiveFailures - 1);
  return Math.min(PROBE_BACKOFF_CAP_MS, PROBE_BACKOFF_BASE_MS * 2 ** exp);
}

/**
 * Refresh-path CLI probe driving the auth-lapsed state's only exit. Runs on
 * exponential backoff while the state is set or any session is auth-parked,
 * idle otherwise. A credentials-file mtime change or the recheck route only
 * run the probe early; only a probe success clears the state.
 */
export class AuthLapseProbe {
  private failures = 0;
  private nextAttemptAt = 0;
  private lastMtimeMs: number | null = null;
  private inFlight: Promise<ProbeOutcome> | null = null;

  constructor(
    private readonly options: {
      exec?: ProbeExec;
      now?: () => number;
      credentialsPath?: string;
      isActive?: () => boolean;
    } = {},
  ) {}

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'cli_auth_probe',
      intervalMs: PROBE_TICK_MS,
      concurrency: 'skip-if-running',
      timeoutMs: PROBE_TIMEOUT_MS + 30_000,
      run: async () => {
        const ran = await this.tick();
        return { items_processed: ran ? 1 : 0 };
      },
    });
  }

  private isActive(): boolean {
    return this.options.isActive
      ? this.options.isActive()
      : getAuthLapse().lapsed || hasAuthParkedSession();
  }

  private credentialsChanged(): boolean {
    let mtime: number | null;
    try {
      mtime = fs.statSync(
        this.options.credentialsPath ?? claudeCredentialsPath(),
      ).mtimeMs;
    } catch {
      mtime = null;
    }
    const changed =
      this.lastMtimeMs !== null && mtime !== null && mtime !== this.lastMtimeMs;
    this.lastMtimeMs = mtime;
    return changed;
  }

  /** One scheduler tick. Returns true if a probe ran. */
  async tick(): Promise<boolean> {
    const changed = this.credentialsChanged();
    if (!this.isActive()) {
      this.failures = 0;
      this.nextAttemptAt = 0;
      return false;
    }
    const now = (this.options.now ?? Date.now)();
    if (!changed && now < this.nextAttemptAt) return false;
    await this.probeNow();
    return true;
  }

  /** Runs the probe immediately (shared across concurrent callers) and updates state/backoff. */
  probeNow(): Promise<ProbeOutcome> {
    this.inFlight ??= this.runProbe().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runProbe(): Promise<ProbeOutcome> {
    const exec = this.options.exec ?? defaultExec;
    let outcome: ProbeOutcome;
    try {
      outcome = classifyProbeResult(await exec());
    } catch {
      outcome = 'other_failure';
    }
    const now = (this.options.now ?? Date.now)();
    if (outcome === 'success') {
      this.failures = 0;
      this.nextAttemptAt = 0;
      if (clearAuthLapse()) {
        logger.info('[AuthLapseProbe] CLI auth restored — lapse cleared');
      }
    } else {
      this.failures += 1;
      this.nextAttemptAt = now + backoffDelayMs(this.failures);
      logger.info(
        `[AuthLapseProbe] probe failed (${outcome}); next attempt in ${backoffDelayMs(this.failures)}ms`,
      );
    }
    return outcome;
  }
}

let _probe: AuthLapseProbe | null = null;

export function setAuthLapseProbe(probe: AuthLapseProbe): void {
  _probe = probe;
}

export function getAuthLapseProbe(): AuthLapseProbe | null {
  return _probe;
}
