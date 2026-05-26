import type { Request, Response, NextFunction } from 'express';
import {
  getDeviceByToken,
  updateDeviceLastSeen,
  getActiveDeviceCount,
} from '../db/queries';
import type { DeviceRow } from '../db/types';

export function validateDeviceToken(token: string): DeviceRow | null {
  return getDeviceByToken(token);
}

export function getTokenFromRequest(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

/** Express middleware — rejects requests without a valid device token.
 *  Bootstrap exception: when no devices are enrolled, passes through so
 *  the enrollment bootstrap endpoint can create the first device.
 *  Enrollment endpoints (/api/enrollment/*) are always permitted. */
export function requireDeviceAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Enrollment endpoints are always accessible without auth
  if (req.path.startsWith('/api/enrollment/')) {
    next();
    return;
  }

  const token = getTokenFromRequest(req);

  if (!token) {
    // Bootstrap: no devices enrolled yet → let request through so
    // /api/enrollment/bootstrap can respond with the first token.
    // We block all other endpoints until enrollment completes.
    const deviceCount = getActiveDeviceCount();
    if (deviceCount === 0) {
      next();
      return;
    }
    res
      .status(401)
      .json({ error: 'unauthorized', code: 'device_not_enrolled' });
    return;
  }

  const device = validateDeviceToken(token);
  if (!device) {
    res.status(401).json({ error: 'unauthorized', code: 'invalid_token' });
    return;
  }

  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)
      ?.split(',')[0]
      .trim() ??
    req.socket.remoteAddress ??
    null;
  updateDeviceLastSeen(device.id, ip, Date.now());

  (req as Request & { device: DeviceRow }).device = device;
  next();
}

/** Validate a device token from a WebSocket upgrade request URL. */
export function validateWsToken(token: string | null): DeviceRow | null {
  if (!token) return null;
  return getDeviceByToken(token);
}
