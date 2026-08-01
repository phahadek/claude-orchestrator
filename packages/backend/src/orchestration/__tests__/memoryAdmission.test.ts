import { describe, it, expect, vi } from 'vitest';

vi.mock('os', () => ({
  default: { freemem: vi.fn() },
  freemem: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  runtimeSettings: {
    min_host_free_memory_mb: 4096,
    per_session_reserve_mb: 3072,
  },
}));

import os from 'os';
import { runtimeSettings } from '../../config.js';
import { evaluateMemoryHeadroom, hasMemoryHeadroom } from '../memoryAdmission';

describe('evaluateMemoryHeadroom', () => {
  it('permits dispatch when projected free memory is at or above the budget', () => {
    expect(
      evaluateMemoryHeadroom({
        freeMemMB: 8192,
        minHostFreeMemoryMB: 4096,
        perSessionReserveMB: 3072,
      }),
    ).toBe(true);

    // Exactly at the floor after reserving — still permitted.
    expect(
      evaluateMemoryHeadroom({
        freeMemMB: 7168,
        minHostFreeMemoryMB: 4096,
        perSessionReserveMB: 3072,
      }),
    ).toBe(true);
  });

  it('defers dispatch when projected free memory would breach the budget', () => {
    expect(
      evaluateMemoryHeadroom({
        freeMemMB: 5000,
        minHostFreeMemoryMB: 4096,
        perSessionReserveMB: 3072,
      }),
    ).toBe(false);
  });
});

describe('hasMemoryHeadroom', () => {
  it('reads live free memory from os.freemem() when no override is passed', () => {
    (os.freemem as ReturnType<typeof vi.fn>).mockReturnValue(
      10 * 1024 * 1024 * 1024,
    );
    expect(hasMemoryHeadroom().allowed).toBe(true);
  });

  it('defers using runtimeSettings budget when projected free memory is too low', () => {
    // 5GB free, reserve 3GB -> projected 2GB, below the 4GB floor.
    expect(hasMemoryHeadroom(5 * 1024 * 1024 * 1024).allowed).toBe(false);
  });

  it('permits when projected free memory clears the configured floor', () => {
    // 8GB free, reserve 3GB -> projected 5GB, above the 4GB floor.
    expect(hasMemoryHeadroom(8 * 1024 * 1024 * 1024).allowed).toBe(true);
  });

  it('respects updated runtimeSettings values', () => {
    runtimeSettings.min_host_free_memory_mb = 1024;
    runtimeSettings.per_session_reserve_mb = 512;
    expect(hasMemoryHeadroom(2 * 1024 * 1024 * 1024).allowed).toBe(true);
    runtimeSettings.min_host_free_memory_mb = 4096;
    runtimeSettings.per_session_reserve_mb = 3072;
  });

  it('returns the observed inputs and the projected value the decision branched on', () => {
    // 5GB free, reserve 3GB -> projected 2GB, below the 4GB floor.
    const result = hasMemoryHeadroom(5 * 1024 * 1024 * 1024);
    expect(result.allowed).toBe(false);
    expect(result.freeMemMB).toBeCloseTo(5120, 1);
    expect(result.minHostFreeMemoryMB).toBe(4096);
    expect(result.perSessionReserveMB).toBe(3072);
    expect(result.projectedFreeMB).toBeCloseTo(2048, 1);
    // The projected value must equal what evaluateMemoryHeadroom actually
    // branches on — guards against the audited/logged value drifting from
    // the real decision.
    expect(result.projectedFreeMB).toBe(
      result.freeMemMB - result.perSessionReserveMB,
    );
    expect(
      evaluateMemoryHeadroom({
        freeMemMB: result.freeMemMB,
        minHostFreeMemoryMB: result.minHostFreeMemoryMB,
        perSessionReserveMB: result.perSessionReserveMB,
      }),
    ).toBe(result.allowed);
  });
});
