import type { Request, Response, NextFunction } from 'express';
import {
  getDeviceByToken,
  updateDeviceLastSeen,
  getActiveDeviceCount,
} from '../db/queries';
import type { DeviceRow } from '../db/types';

export function isLoopbackIp(addr: string): boolean {
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.')
  );
}

function validateDeviceToken(token: string): DeviceRow | null {
  return getDeviceByToken(token);
}

function getTokenFromRequest(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

/** Express middleware — rejects requests without a valid device token.
 *  Bootstrap exception: when no devices are enrolled, passes through so
 *  the enrollment bootstrap endpoint can create the first device. */
export function requireDeviceAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = getTokenFromRequest(req);

  if (!token) {
    // Bootstrap: no devices enrolled yet → let request through so
    // /api/enrollment/bootstrap can respond with the first token.
    // We block all other endpoints until enrollment completes.
    const deviceCount = getActiveDeviceCount();
    if (deviceCount === 0) {
      // Bootstrap window is loopback-only to prevent enrollment hijack from the network.
      const remoteAddr = req.socket.remoteAddress ?? '';
      if (!isLoopbackIp(remoteAddr)) {
        res
          .status(403)
          .json({ error: 'forbidden', code: 'bootstrap_loopback_only' });
        return;
      }
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
