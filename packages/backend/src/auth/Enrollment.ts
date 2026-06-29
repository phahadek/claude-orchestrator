import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import {
  insertDevice,
  getDeviceById,
  listDevices,
  updateDeviceName,
  revokeDevice,
  getActiveDeviceCount,
} from '../db/queries';
import type { ServerMessage } from '../ws/types';

export type EnrollmentStatus = 'pending' | 'approved' | 'expired';

interface PendingEnrollment {
  code: string;
  name: string;
  userAgent: string;
  ip: string;
  expiresAt: number;
  approved: boolean;
  token?: string;
  deviceId?: string;
}

// In-memory store for pending enrollment requests (5-minute TTL)
const pendingEnrollments = new Map<string, PendingEnrollment>();

const CODE_TTL_MS = 5 * 60 * 1000;

function generateCode(): string {
  // 6-digit numeric code
  return String(Math.floor(100000 + crypto.randomInt(900000)));
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function generateDeviceId(): string {
  return crypto.randomUUID();
}

function cleanExpired(): void {
  const now = Date.now();
  for (const [code, entry] of pendingEnrollments) {
    if (entry.expiresAt <= now) {
      pendingEnrollments.delete(code);
    }
  }
}

export function requestEnrollment(
  name: string,
  userAgent: string,
  ip: string,
): { code: string } {
  cleanExpired();
  const code = generateCode();
  pendingEnrollments.set(code, {
    code,
    name,
    userAgent,
    ip,
    expiresAt: Date.now() + CODE_TTL_MS,
    approved: false,
  });
  return { code };
}

export function getEnrollmentStatus(code: string): {
  status: EnrollmentStatus;
  token?: string;
  deviceId?: string;
} {
  const entry = pendingEnrollments.get(code);
  if (!entry) return { status: 'expired' };
  if (entry.expiresAt <= Date.now()) {
    pendingEnrollments.delete(code);
    return { status: 'expired' };
  }
  if (entry.approved) {
    return { status: 'approved', token: entry.token, deviceId: entry.deviceId };
  }
  return { status: 'pending' };
}

export function approveEnrollment(
  code: string,
): { token: string; deviceId: string } | null {
  const entry = pendingEnrollments.get(code);
  if (!entry || entry.expiresAt <= Date.now() || entry.approved) return null;

  const token = generateToken();
  const deviceId = generateDeviceId();
  const now = Date.now();

  insertDevice({
    id: deviceId,
    name: entry.name || 'New Device',
    user_agent: entry.userAgent,
    last_ip: entry.ip,
    last_seen: now,
    enrolled_at: now,
    token,
  });

  entry.approved = true;
  entry.token = token;
  entry.deviceId = deviceId;

  return { token, deviceId };
}

export function bootstrapEnroll(
  name: string,
  userAgent: string,
  ip: string,
): { token: string; deviceId: string } | null {
  if (getActiveDeviceCount() > 0) return null;

  const token = generateToken();
  const deviceId = generateDeviceId();
  const now = Date.now();

  insertDevice({
    id: deviceId,
    name: name || 'First Device',
    user_agent: userAgent,
    last_ip: ip,
    last_seen: now,
    enrolled_at: now,
    token,
  });

  return { token, deviceId };
}

// Exported for tests
export { pendingEnrollments };

type BroadcastFn = (msg: ServerMessage) => void;
let broadcastFn: BroadcastFn | null = null;

export function setEnrollmentBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
}

export function createEnrollmentRouter(): Router {
  const router = Router();

  // GET /api/enrollment/needs-bootstrap — public, no token required
  router.get('/needs-bootstrap', (_req: Request, res: Response) => {
    res.json({ needsBootstrap: getActiveDeviceCount() === 0 });
  });

  // POST /api/enrollment/bootstrap — first device only (no auth required)
  router.post('/bootstrap', (req: Request, res: Response) => {
    const userAgent = req.headers['user-agent'] ?? '';
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        .trim() ??
      req.socket.remoteAddress ??
      '';
    const name =
      typeof (req.body as { name?: string }).name === 'string'
        ? (req.body as { name: string }).name
        : 'First Device';

    const result = bootstrapEnroll(name, userAgent, ip);
    if (!result) {
      res.status(403).json({ error: 'devices already enrolled' });
      return;
    }
    res.json(result);
  });

  // POST /api/enrollment/request — request pairing code (no auth required)
  router.post('/request', (req: Request, res: Response) => {
    const userAgent = req.headers['user-agent'] ?? '';
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        .trim() ??
      req.socket.remoteAddress ??
      '';
    const name =
      typeof (req.body as { name?: string }).name === 'string'
        ? (req.body as { name: string }).name
        : 'New Device';

    const { code } = requestEnrollment(name, userAgent, ip);

    // Broadcast enrollment_request to all enrolled devices
    if (broadcastFn) {
      broadcastFn({
        type: 'enrollment_request',
        code,
        deviceName: name,
        userAgent,
        ip,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
    }

    res.json({ code });
  });

  // GET /api/enrollment/status — poll for approval (no auth required)
  router.get('/status', (req: Request, res: Response) => {
    const code = (req.query as { code?: string }).code;
    if (!code) {
      res.status(400).json({ error: 'code required' });
      return;
    }
    const result = getEnrollmentStatus(code);
    res.json(result);
  });

  // POST /api/enrollment/approve — approve a pending code (auth required via middleware)
  router.post('/approve', (req: Request, res: Response) => {
    const { code } = req.body as { code?: string };
    if (!code) {
      res.status(400).json({ error: 'code required' });
      return;
    }
    const result = approveEnrollment(code);
    if (!result) {
      res.status(400).json({ error: 'invalid or expired code' });
      return;
    }
    res.json({ ok: true, ...result });
  });

  // GET /api/enrollment/devices — list enrolled devices (auth required)
  router.get('/devices', (_req: Request, res: Response) => {
    const devices = listDevices().map((d) => ({
      id: d.id,
      name: d.name,
      userAgent: d.user_agent,
      lastIp: d.last_ip,
      lastSeen: d.last_seen,
      enrolledAt: d.enrolled_at,
      revoked: d.revoked === 1,
    }));
    res.json(devices);
  });

  // PATCH /api/enrollment/devices/:id — update device name (auth required)
  router.patch('/devices/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const device = getDeviceById(id);
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }
    updateDeviceName(id, name);
    res.json({ ok: true });
  });

  // DELETE /api/enrollment/devices/:id — revoke device (auth required)
  router.delete('/devices/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const device = getDeviceById(id);
    if (!device) {
      res.status(404).json({ error: 'device not found' });
      return;
    }
    revokeDevice(id);
    res.json({ ok: true });
  });

  return router;
}
