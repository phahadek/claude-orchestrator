import type { Request } from 'express';
import type { DeviceRow } from '../db/types';

/**
 * Resolves the operator to attribute an action to: an explicit body value
 * always wins (naming a human behind a shared device/session); otherwise the
 * authenticated caller identity — the device name for a device-authed caller,
 * or a session-derived label for a caller authenticated via a per-session
 * route credential (requireDeviceOrSessionRouteAuth sets exactly one of
 * req.device / req.routeSession, never both).
 */
export function resolveOperator(
  req: Request,
  bodyOperator: unknown,
): string | undefined {
  if (typeof bodyOperator === 'string' && bodyOperator) {
    return bodyOperator;
  }
  const device = (req as Request & { device?: DeviceRow }).device;
  if (device) {
    return device.name;
  }
  const routeSession = (
    req as Request & { routeSession?: { sessionId: string } }
  ).routeSession;
  if (routeSession) {
    return `session:${routeSession.sessionId}`;
  }
  return undefined;
}
