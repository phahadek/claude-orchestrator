export interface JobStatus {
  name: string;
  running: boolean;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'failed' | 'skipped' | null;
  nextRunAt: string | null;
  lastDurationMs?: number | null;
  runCount24h?: number | null;
  errorCount24h?: number | null;
}

import { authedFetch } from './projects';

export async function fetchSchedulerStatus(): Promise<JobStatus[]> {
  const res = await authedFetch('/api/diagnostics/scheduler');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<JobStatus[]>;
}

export async function triggerSchedulerJob(name: string): Promise<void> {
  const res = await authedFetch(
    `/api/diagnostics/scheduler/${encodeURIComponent(name)}/trigger`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`${res.status}`);
}
