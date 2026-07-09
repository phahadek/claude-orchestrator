import fs from 'fs';
import { logger } from '../logger';
import { claudeCredentialsPath } from '../config/credentialsPath';
import type { Scheduler } from './Scheduler';
import type { ServerMessage, PlanUsage, UsageWindow } from '../ws/types';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const POLL_INTERVAL_MS = 60_000;

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
 * Polls the Claude subscription plan-usage endpoint every 60s, re-reading the
 * OAuth token from ~/.claude/.credentials.json on each tick (the CLI keeps it
 * refreshed as it spawns sessions — this poller never refreshes it itself).
 * Any failure (stale token, API-key project, non-200, network error) degrades
 * to `{ available: false }` rather than surfacing an error to the UI.
 */
export class PlanUsagePoller {
  private cache: PlanUsage = UNAVAILABLE;

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
        logger.warn(
          `[PlanUsagePoller] poll error: ${(err as Error).message}`,
        ),
    });
  }

  async poll(): Promise<void> {
    const next = await this.fetchUsage();
    const changed = JSON.stringify(next) !== JSON.stringify(this.cache);
    this.cache = next;
    if (changed) {
      this.broadcast({ type: 'plan_usage', usage: next });
    }
  }

  private async fetchUsage(): Promise<PlanUsage> {
    let raw: string;
    try {
      raw = fs.readFileSync(claudeCredentialsPath(), 'utf8');
    } catch {
      return UNAVAILABLE;
    }

    let creds: OauthCredentials;
    try {
      creds = JSON.parse(raw) as OauthCredentials;
    } catch {
      return UNAVAILABLE;
    }

    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return UNAVAILABLE;
    if (typeof oauth.expiresAt === 'number' && Date.now() > oauth.expiresAt) {
      // Token momentarily stale — skip this tick rather than attempt a refresh.
      return UNAVAILABLE;
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
      logger.warn(
        `[PlanUsagePoller] fetch failed: ${(err as Error).message}`,
      );
      return UNAVAILABLE;
    }

    if (!res.ok) return UNAVAILABLE;

    let body: UsageResponse;
    try {
      body = (await res.json()) as UsageResponse;
    } catch {
      return UNAVAILABLE;
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

    if (!fiveHour && !weekly) return UNAVAILABLE;

    return { available: true, fiveHour, weekly };
  }
}
