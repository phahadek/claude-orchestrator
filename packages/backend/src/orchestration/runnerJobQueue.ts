import type { RunnerResultPackage } from './runnerResultPackage';
import type { TestSnapshot } from './testSnapshot';
import { RUNNER_UNREACHABLE_GRACE_MS } from './runnerUnreachabilityReconciler';

export class RunnerUnreachableError extends Error {
  constructor(readonly runId: string) {
    super(`No runner result for run ${runId} within the grace period`);
    this.name = 'RunnerUnreachableError';
  }
}

export interface EnqueueRunnerJobInput {
  runId: string;
  projectId: string;
  /** Non-secret dispatch spec (commands, timeouts, etc.). */
  spec: Record<string, unknown>;
  snapshot: TestSnapshot;
  contentHash: string;
  testReportGlob: string | null;
}

/** What a runner sees when polling — no snapshot bytes, no secrets. */
export interface RunnerJobDescriptor {
  runId: string;
  projectId: string;
  contentHash: string;
  totalBytes: number;
}

export interface ClaimedRunnerJob extends RunnerJobDescriptor {
  spec: Record<string, unknown>;
  manifest: TestSnapshot['manifest'];
  testReportGlob: string | null;
}

interface QueuedJob {
  input: EnqueueRunnerJobInput;
  claimedBy: string | null;
  resolve: (pkg: RunnerResultPackage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const jobs = new Map<string, QueuedJob>();

function descriptorOf(input: EnqueueRunnerJobInput): RunnerJobDescriptor {
  return {
    runId: input.runId,
    projectId: input.projectId,
    contentHash: input.contentHash,
    totalBytes: input.snapshot.manifest.totalBytes,
  };
}

export function enqueueRunnerJob(
  input: EnqueueRunnerJobInput,
  graceMs: number = RUNNER_UNREACHABLE_GRACE_MS,
): Promise<RunnerResultPackage> {
  return new Promise<RunnerResultPackage>((resolve, reject) => {
    if (jobs.has(input.runId)) {
      reject(new Error(`Runner job already queued for run ${input.runId}`));
      return;
    }
    const timer = setTimeout(() => {
      jobs.delete(input.runId);
      reject(new RunnerUnreachableError(input.runId));
    }, graceMs);
    timer.unref?.();
    jobs.set(input.runId, {
      input,
      claimedBy: null,
      resolve,
      reject,
      timer,
    });
  });
}

export function listClaimableJobs(): RunnerJobDescriptor[] {
  return [...jobs.values()]
    .filter((j) => j.claimedBy === null)
    .map((j) => descriptorOf(j.input));
}

/** Returns the job once; null when absent or already claimed. */
export function claimRunnerJob(
  runId: string,
  deviceId: string,
): ClaimedRunnerJob | null {
  const job = jobs.get(runId);
  if (!job || job.claimedBy !== null) return null;
  job.claimedBy = deviceId;
  return {
    ...descriptorOf(job.input),
    spec: job.input.spec,
    manifest: job.input.snapshot.manifest,
    testReportGlob: job.input.testReportGlob,
  };
}

/** The gzip archive, only for the device that claimed the job. */
export function getRunnerJobSnapshot(
  runId: string,
  deviceId: string,
): Buffer | null {
  const job = jobs.get(runId);
  if (!job || job.claimedBy !== deviceId) return null;
  return job.input.snapshot.archive;
}

/** Settles the job; false when absent or not claimed by this device. */
export function submitRunnerResult(
  runId: string,
  deviceId: string,
  pkg: RunnerResultPackage,
): boolean {
  const job = jobs.get(runId);
  if (!job || job.claimedBy !== deviceId) return false;
  clearTimeout(job.timer);
  jobs.delete(runId);
  job.resolve(pkg);
  return true;
}

export function _resetRunnerJobQueueForTests(): void {
  for (const j of jobs.values()) clearTimeout(j.timer);
  jobs.clear();
}
