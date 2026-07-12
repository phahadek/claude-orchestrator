import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { isLoopbackIp } from './DeviceAuth';

/**
 * Per-session scoped stage credential: minted once per session at spawn,
 * injected into the session's spawn env, and only ever accepted by the
 * loopback-only stage endpoint (POST /api/task-intents). It authorizes
 * staging a task-write intent — never applying one. See Technical
 * Architecture § Task-Write Command Vocabulary & Transport.
 */
interface StageCredential {
  sessionId: string;
  createdAt: number;
}

const credentialsByToken = new Map<string, StageCredential>();
const tokenBySession = new Map<string, string>();

/** Mint (or return the existing) stage credential for a session. Idempotent
 *  across resumes/escalations so a session keeps one token for its lifetime. */
export function mintStageCredential(sessionId: string): string {
  const existing = tokenBySession.get(sessionId);
  if (existing) return existing;
  const token = randomUUID();
  tokenBySession.set(sessionId, token);
  credentialsByToken.set(token, { sessionId, createdAt: Date.now() });
  return token;
}

/** Revoke a session's stage credential. Safe to call multiple times. */
export function revokeStageCredential(sessionId: string): void {
  const token = tokenBySession.get(sessionId);
  if (!token) return;
  tokenBySession.delete(sessionId);
  credentialsByToken.delete(token);
}

/** Look up the session bound to a stage credential token, or null if invalid/revoked. */
function validateStageCredential(token: string): { sessionId: string } | null {
  const cred = credentialsByToken.get(token);
  return cred ? { sessionId: cred.sessionId } : null;
}

/** Test-only: reset all in-memory credential state. */
export function _resetStageCredentialsForTesting(): void {
  credentialsByToken.clear();
  tokenBySession.clear();
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/**
 * Scoped-auth middleware for the stage endpoint only. Accepts *only* session
 * stage credentials (never device tokens), and only over loopback — sessions
 * run on the same host as the backend, so a non-loopback caller can never
 * legitimately hold one. Wire this to the stage endpoint alone; it must never
 * be mounted on the human/device apply surface.
 */
export function requireSessionStageAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const remoteAddr = req.socket.remoteAddress ?? '';
  if (!isLoopbackIp(remoteAddr)) {
    res.status(403).json({ error: 'forbidden', code: 'stage_loopback_only' });
    return;
  }

  const token = getBearerToken(req);
  if (!token) {
    res
      .status(401)
      .json({ error: 'unauthorized', code: 'stage_credential_required' });
    return;
  }

  const session = validateStageCredential(token);
  if (!session) {
    res
      .status(401)
      .json({ error: 'unauthorized', code: 'invalid_stage_credential' });
    return;
  }

  (req as Request & { stageSession: { sessionId: string } }).stageSession =
    session;
  next();
}
