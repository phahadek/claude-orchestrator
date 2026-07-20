import fs from 'fs';
import { logger } from '../logger';
import { claudeCredentialsPath } from '../config/credentialsPath';
import type { Scheduler } from './Scheduler';
import type { ServerMessage, PlanUsage, UsageWindow } from '../ws/types';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const POLL_INTERVAL_MS = 60_000;
/** Consecutive transient failures tolerated before falling back to UNAVAILABLE. */
const MAX_TRANSIENT_FAILURES = 3;

const UNAVAILABLE: PlanUsage = { available: false };

interface OauthCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
  };
}

interface UsageLimit {
  kind: string;
  percent: number;
  severity: string;
  resets_at: string;
}

interface UsageResponse {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  limits?: UsageLimit[];
}

/**
 * Outcome of a single fetch attempt. `definitive-unavailable` means the
 * account is genuinely not usage-tracked (401/403, or creds legitimately
 * absent) and should clear the UI immediately. `transient` means the failure
 * is likely momentary (network error, timeout, 5xx, other non-2xx, malformed
 * body, token-refresh race) and the last-known-good snapshot should be
 * retained instead of flickering the bars away.
 */
type FetchResult =
  | { kind: 'ok'; usage: PlanUsage }
  | { kind: 'transient' }
  | { kind: 'definitive-unavailable' };

/**
 * Polls the Claude subscription plan-usage endpoint every 60s, re-reading the
 * OAuth token from ~/.claude/.credentials.json on each tick (the CLI keeps it
 * refreshed as it spawns sessions — this poller never refreshes it itself).
 * Transient failures (network errors, timeouts, 5xx, a token-refresh race)
 * retain the last-known-good snapshot for up to MAX_TRANSIENT_FAILURES ticks
 * so the UI doesn't flicker; only a definitive signal (401/403, or creds
 * legitimately absent) clears it immediately.
 */
export class PlanUsagePoller {
  private cache: PlanUsage = UNAVAILABLE;
  private lastGood: PlanUsage | null = null;
  private consecutiveTransientFailures = 0;

  constructor(private readonly broadcast: (msg: ServerMessage) => void) {}

  getCache(): PlanUsage {
    return this.cache;
  }

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'plan_usage_poller',
      intervalMs: POLL_INTERVAL_MS,
      runOnBoot: true,
      concurrency: 'skip-if-running',
      run: async () => {
        await this.poll();
      },
      onError: (err) =>
        logger.warn(`[PlanUsagePoller] poll error: ${(err as Error).message}`),
    });
  }

  async poll(): Promise<void> {
    const result = await this.fetchUsage();
    const next = this.resolve(result);
    const changed = JSON.stringify(next) !== JSON.stringify(this.cache);
    this.cache = next;
    if (changed) {
      this.broadcast({ type: 'plan_usage', usage: next });
    }
  }

  private resolve(result: FetchResult): PlanUsage {
    if (result.kind === 'ok') {
      this.consecutiveTransientFailures = 0;
      this.lastGood = result.usage;
      return result.usage;
    }

    if (result.kind === 'definitive-unavailable') {
      this.consecutiveTransientFailures = 0;
      this.lastGood = null;
      return UNAVAILABLE;
    }

    // Transient failure: hold on to the last-known-good snapshot until we've
    // seen enough consecutive failures to conclude it's no longer momentary.
    this.consecutiveTransientFailures += 1;
    if (
      this.lastGood &&
      this.consecutiveTransientFailures <= MAX_TRANSIENT_FAILURES
    ) {
      return { ...this.lastGood, stale: true };
    }
    return UNAVAILABLE;
  }

  private async fetchUsage(): Promise<FetchResult> {
    let raw: string;
    try {
      raw = fs.readFileSync(claudeCredentialsPath(), 'utf8');
    } catch {
      return { kind: 'definitive-unavailable' };
    }

    let creds: OauthCredentials;
    try {
      creds = JSON.parse(raw) as OauthCredentials;
    } catch {
      return { kind: 'definitive-unavailable' };
    }

    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return { kind: 'definitive-unavailable' };
    if (typeof oauth.expiresAt === 'number' && Date.now() > oauth.expiresAt) {
      // Token momentarily stale — likely a refresh race, retry next tick.
      return { kind: 'transient' };
    }

    let res: Response;
    try {
      res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
        },
      });
    } catch (err) {
      logger.warn(`[PlanUsagePoller] fetch failed: ${(err as Error).message}`);
      return { kind: 'transient' };
    }

    if (res.status === 401 || res.status === 403) {
      return { kind: 'definitive-unavailable' };
    }
    if (!res.ok) return { kind: 'transient' };

    let body: UsageResponse;
    try {
      body = (await res.json()) as UsageResponse;
    } catch {
      return { kind: 'transient' };
    }

    const sessionLimit = body.limits?.find((l) => l.kind === 'session');
    const weeklyLimit = body.limits?.find((l) => l.kind === 'weekly_all');

    const fiveHour: UsageWindow | undefined = sessionLimit
      ? {
          percent: sessionLimit.percent,
          resetsAt: sessionLimit.resets_at,
          severity: sessionLimit.severity,
        }
      : body.five_hour
        ? {
            percent: body.five_hour.utilization,
            resetsAt: body.five_hour.resets_at,
            severity: 'normal',
          }
        : undefined;

    const weekly: UsageWindow | undefined = weeklyLimit
      ? {
          percent: weeklyLimit.percent,
          resetsAt: weeklyLimit.resets_at,
          severity: weeklyLimit.severity,
        }
      : body.seven_day
        ? {
            percent: body.seven_day.utilization,
            resetsAt: body.seven_day.resets_at,
            severity: 'normal',
          }
        : undefined;

    if (!fiveHour && !weekly) return { kind: 'transient' };

    return { kind: 'ok', usage: { available: true, fiveHour, weekly } };
  }
}
