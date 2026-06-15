export interface JobStatus {
  name: string;
  running: boolean;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'failed' | 'skipped' | null;
  nextRunAt: string | null;
  lastDurationMs?: number | null;
}

export async function fetchSchedulerStatus(): Promise<JobStatus[]> {
  const res = await fetch('/api/diagnostics/scheduler');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<JobStatus[]>;
}

export async function triggerSchedulerJob(name: string): Promise<void> {
  const res = await fetch(
    `/api/diagnostics/scheduler/${encodeURIComponent(name)}/trigger`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`${res.status}`);
}
