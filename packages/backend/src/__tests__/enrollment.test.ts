import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── Source-level checks ──────────────────────────────────────────────────────

describe('Enrollment.ts — source checks', () => {
  it('enrollment_request WS event is sent when a new device requests', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'auth', 'Enrollment.ts'),
      'utf-8',
    );
    expect(source).toMatch(/enrollment_request/);
    expect(source).toMatch(/broadcastFn/);
  });

  it('code TTL is 5 minutes', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'auth', 'Enrollment.ts'),
      'utf-8',
    );
    expect(source).toMatch(/5 \* 60 \* 1000/);
  });

  it('generates a 6-digit code', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'auth', 'Enrollment.ts'),
      'utf-8',
    );
    // 100000 to 999999 = 6-digit range
    expect(source).toMatch(/100000/);
    expect(source).toMatch(/900000/);
  });
});

// ── Enrollment logic unit tests ──────────────────────────────────────────────

vi.mock('../db/queries', () => ({
  insertDevice: vi.fn(),
  getDeviceById: vi.fn(),
  listDevices: vi.fn(() => []),
  updateDeviceName: vi.fn(),
  revokeDevice: vi.fn(),
  getActiveDeviceCount: vi.fn(),
  getDeviceByToken: vi.fn(),
  updateDeviceLastSeen: vi.fn(),
}));

import {
  requestEnrollment,
  getEnrollmentStatus,
  approveEnrollment,
  bootstrapEnroll,
  pendingEnrollments,
} from '../auth/Enrollment.js';
import * as queries from '../db/queries';

beforeEach(() => {
  vi.clearAllMocks();
  pendingEnrollments.clear();
});

describe('requestEnrollment()', () => {
  it('returns a 6-digit numeric code', () => {
    const { code } = requestEnrollment('Test', 'UA', '127.0.0.1');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('stores the pending enrollment with a 5-minute TTL', () => {
    const before = Date.now();
    const { code } = requestEnrollment('Test', 'UA', '127.0.0.1');
    const entry = pendingEnrollments.get(code);
    expect(entry).toBeDefined();
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 50);
    expect(entry!.expiresAt).toBeLessThanOrEqual(before + 5 * 60 * 1000 + 50);
  });
});

describe('getEnrollmentStatus()', () => {
  it('returns expired for unknown code', () => {
    expect(getEnrollmentStatus('000000')).toEqual({ status: 'expired' });
  });

  it('returns pending for a fresh code', () => {
    const { code } = requestEnrollment('Test', 'UA', '127.0.0.1');
    expect(getEnrollmentStatus(code)).toEqual({ status: 'pending' });
  });

  it('returns expired for an expired code', () => {
    const { code } = requestEnrollment('Test', 'UA', '127.0.0.1');
    // Backdate the TTL
    const entry = pendingEnrollments.get(code)!;
    entry.expiresAt = Date.now() - 1;
    expect(getEnrollmentStatus(code)).toEqual({ status: 'expired' });
  });
});

describe('approveEnrollment()', () => {
  it('creates a device and returns token + deviceId', () => {
    vi.mocked(queries.insertDevice).mockReturnValue(undefined);
    const { code } = requestEnrollment('Test', 'UA', '127.0.0.1');
    const result = approveEnrollment(code);
    expect(result).not.toBeNull();
    expect(result!.token).toBeTruthy();
    expect(result!.deviceId).toBeTruthy();
    expect(queries.insertDevice).toHaveBeenCalledOnce();
  });

  it('marks the code as approved', () => {
    vi.mocked(queries.insertDevice).mockReturnValue(undefined);
    const { code } = requestEnrollment('Test', 'UA', '127.0.0.1');
    approveEnrollment(code);
    const status = getEnrollmentStatus(code);
    expect(status.status).toBe('approved');
    expect(status.token).toBeTruthy();
  });

  it('a code can only be redeemed once — second call fails', () => {
    vi.mocked(queries.insertDevice).mockReturnValue(undefined);
    const { code } = requestEnrollment('Test', 'UA', '127.0.0.1');
    const first = approveEnrollment(code);
    const second = approveEnrollment(code);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    // insertDevice called only once
    expect(queries.insertDevice).toHaveBeenCalledOnce();
  });

  it('returns null for unknown code', () => {
    expect(approveEnrollment('000000')).toBeNull();
  });

  it('returns null for expired code', () => {
    const { code } = requestEnrollment('Test', 'UA', '127.0.0.1');
    pendingEnrollments.get(code)!.expiresAt = Date.now() - 1;
    expect(approveEnrollment(code)).toBeNull();
  });
});

describe('bootstrapEnroll()', () => {
  it('enrolls the first device when no devices exist', () => {
    vi.mocked(queries.getActiveDeviceCount).mockReturnValue(0);
    vi.mocked(queries.insertDevice).mockReturnValue(undefined);
    const result = bootstrapEnroll('First', 'UA', '127.0.0.1');
    expect(result).not.toBeNull();
    expect(result!.token).toBeTruthy();
    expect(result!.deviceId).toBeTruthy();
    expect(queries.insertDevice).toHaveBeenCalledOnce();
  });

  it('returns null when devices are already enrolled', () => {
    vi.mocked(queries.getActiveDeviceCount).mockReturnValue(1);
    const result = bootstrapEnroll('Second', 'UA', '127.0.0.1');
    expect(result).toBeNull();
    expect(queries.insertDevice).not.toHaveBeenCalled();
  });
});
