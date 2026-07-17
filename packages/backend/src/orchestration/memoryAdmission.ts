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

/**
 * Pure admission check: true when launching one more session would leave
 * projected free memory (current free minus the per-session reserve) at or
 * above the configured floor.
 */
export function evaluateMemoryHeadroom(inputs: MemoryHeadroomInputs): boolean {
  const projectedFreeMB = inputs.freeMemMB - inputs.perSessionReserveMB;
  return projectedFreeMB >= inputs.minHostFreeMemoryMB;
}

/**
 * Host-backed admission check used by the dispatcher. Reads live free memory
 * via os.freemem() (overridable for tests) and the configured budget from
 * runtimeSettings.
 */
export function hasMemoryHeadroom(
  freeMemBytes: number = os.freemem(),
): boolean {
  const freeMemMB = freeMemBytes / (1024 * 1024);
  return evaluateMemoryHeadroom({
    freeMemMB,
    minHostFreeMemoryMB: runtimeSettings.min_host_free_memory_mb,
    perSessionReserveMB: runtimeSettings.per_session_reserve_mb,
  });
}
