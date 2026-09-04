import { useState, useEffect, useCallback } from 'react';
import type { ServerMessage } from '@claude-orchestrator/backend/src/ws/types';
import { useWebSocket } from './useWebSocket';
import type { AdmissionStats, JobStatus } from '../api/diagnostics';
import { fetchSchedulerStatus, triggerSchedulerJob } from '../api/diagnostics';

export type { JobStatus, AdmissionStats };

export function useSchedulerStatus() {
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [admission, setAdmission] = useState<AdmissionStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchSchedulerStatus()
      .then((res) => {
        setJobs(res.jobs);
        setAdmission(res.admission);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const handleMessage = useCallback((msg: ServerMessage) => {
    if (msg.type !== 'scheduler_job_run') return;
    setJobs((prev) =>
      prev.map((j) =>
        j.name === msg.job
          ? {
              ...j,
              lastRunAt: msg.completed_at,
              lastStatus: msg.status,
              lastDurationMs: msg.duration_ms,
              running: false,
              queued: false,
              nextRunAt: msg.next_run_at,
            }
          : j,
      ),
    );
  }, []);

  useWebSocket(handleMessage);

  const trigger = useCallback(async (name: string) => {
    setJobs((prev) =>
      prev.map((j) => (j.name === name ? { ...j, queued: true } : j)),
    );
    try {
      await triggerSchedulerJob(name);
    } catch {
      setJobs((prev) =>
        prev.map((j) => (j.name === name ? { ...j, queued: false } : j)),
      );
    }
  }, []);

  return { jobs, admission, loading, error, trigger };
}
