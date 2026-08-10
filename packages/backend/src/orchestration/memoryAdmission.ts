import os from 'os';
import { runtimeSettings } from '../config';

export interface MemoryHeadroomInputs {
  /** Current host free memory, in MB. */
  freeMemMB: number;
  /** Floor below which dispatch must be deferred, in MB. */
  minHostFreeMemoryMB: number;
  /** Estimated memory the next session will consume, in MB. */
  perSessionReserveMB: number;
}

export interface MemoryHeadroomResult extends MemoryHeadroomInputs {
  /** Whether dispatch is admitted. */
  allowed: boolean;
  /** freeMemMB - perSessionReserveMB — the value the decision branches on. */
  projectedFreeMB: number;
}

/**
 * Pure admission check: true when launching one more session would leave
 * projected free memory (current free minus the per-session reserve) at or
 * above the configured floor.
 *
 * The reserve is scaled for exactly one additional session, not multiplied
 * by the count of already-running sessions — os.freemem() (MemAvailable)
 * already reflects the memory those running sessions are using, so scaling
 * by active count would double-count them. The reserve only needs to cover
 * the one new session this check is gating.
 */
export function evaluateMemoryHeadroom(inputs: MemoryHeadroomInputs): boolean {
  const projectedFreeMB = inputs.freeMemMB - inputs.perSessionReserveMB;
  return projectedFreeMB >= inputs.minHostFreeMemoryMB;
}

/**
 * Host-backed admission check used by the dispatcher. Reads live free memory
 * via os.freemem() (overridable for tests) and the configured budget from
 * runtimeSettings. Returns the decision along with the inputs and projected
 * value it was computed from, so the caller can log/audit them without
 * recomputing (and risking drift from) the actual decision.
 */
export function hasMemoryHeadroom(
  freeMemBytes: number = os.freemem(),
): MemoryHeadroomResult {
  const freeMemMB = freeMemBytes / (1024 * 1024);
  const minHostFreeMemoryMB = runtimeSettings.min_host_free_memory_mb;
  const perSessionReserveMB = runtimeSettings.per_session_reserve_mb;
  const projectedFreeMB = freeMemMB - perSessionReserveMB;
  const allowed = evaluateMemoryHeadroom({
    freeMemMB,
    minHostFreeMemoryMB,
    perSessionReserveMB,
  });
  return {
    allowed,
    freeMemMB,
    minHostFreeMemoryMB,
    perSessionReserveMB,
    projectedFreeMB,
  };
}

/**
 * Admission check for the test.request governed lane
 * (orchestration/testRequestLane.ts): folds the per-project concurrency cap
 * into the same host memory-headroom check every other dispatch decision
 * goes through, rather than admitting a test run purely off the project's
 * own semaphore and leaving it to starve the host independently. `inFlight`
 * is the count of test.request runs currently executing for this project
 * (before admitting the caller's own request); `perProjectLimit` is
 * `runtimeSettings.test_request_max_concurrent_per_project`.
 */
export function hasTestRequestAdmission(
  inFlight: number,
  perProjectLimit: number,
  freeMemBytes: number = os.freemem(),
): boolean {
  if (inFlight >= perProjectLimit) return false;
  return hasMemoryHeadroom(freeMemBytes).allowed;
}
