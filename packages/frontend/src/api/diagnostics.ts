export interface JobStatus {
  name: string;
  /** True once the job is actually executing (holds a global concurrency slot). */
  running: boolean;
  /** True while the job is waiting for a free global concurrency slot. */
  queued: boolean;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'failed' | 'skipped' | 'degraded' | null;
  nextRunAt: string | null;
  lastDurationMs?: number | null;
  runCount24h?: number | null;
  errorCount24h?: number | null;
}

export interface AdmissionStats {
  occupiedSlots: number;
  pendingAdmission: number;
}

export interface SchedulerStatusResponse {
  jobs: JobStatus[];
  admission: AdmissionStats;
}

import { authedFetch } from './projects';

export async function fetchSchedulerStatus(): Promise<SchedulerStatusResponse> {
  const res = await authedFetch('/api/diagnostics/scheduler');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<SchedulerStatusResponse>;
}

export async function triggerSchedulerJob(name: string): Promise<void> {
  const res = await authedFetch(
    `/api/diagnostics/scheduler/${encodeURIComponent(name)}/trigger`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`${res.status}`);
}
