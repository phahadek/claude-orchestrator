import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { isLoopbackIp, requireDeviceAuth } from './DeviceAuth';

/**
 * Per-session scoped journal-write credential: minted once per dispatched
 * `ops` session at spawn, injected into the session's spawn env, and only
 * ever accepted by the ops-journal write endpoint (POST
 * /api/ops-journal/:taskId/state). It authorizes driving that one task's
 * ops_journal entry through the staging transitions (pending ->
 * candidate/staged-proposal, -> blocked/incident-frozen, staged-proposal ->
 * applied-pending-confirm) — never -> resolved, which stays
 * device-auth/operator-only. See opsJournal route for the resolved gate.
 *
 * ADDITIVE: this sits alongside, never in place of, the existing
 * device-authed interactive /ops path — a device token keeps full
 * unrestricted journal access (including -> resolved) via the fallthrough
 * to requireDeviceAuth below.
 */
interface OpsJournalCredential {
  sessionId: string;
  createdAt: number;
}

const credentialsByToken = new Map<string, OpsJournalCredential>();
const tokenBySession = new Map<string, string>();

/** Mint (or return the existing) journal credential for a session. Idempotent
 *  across resumes/escalations so a session keeps one token for its lifetime. */
export function mintOpsJournalCredential(sessionId: string): string {
  const existing = tokenBySession.get(sessionId);
  if (existing) return existing;
  const token = randomUUID();
  tokenBySession.set(sessionId, token);
  credentialsByToken.set(token, { sessionId, createdAt: Date.now() });
  return token;
}

/** Revoke a session's journal credential. Safe to call multiple times. */
export function revokeOpsJournalCredential(sessionId: string): void {
  const token = tokenBySession.get(sessionId);
  if (!token) return;
  tokenBySession.delete(sessionId);
  credentialsByToken.delete(token);
}

/** Test-only: reset all in-memory credential state. */
export function _resetOpsJournalCredentialsForTesting(): void {
  credentialsByToken.clear();
  tokenBySession.clear();
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

export type OpsJournalWriteAuthedRequest = Request & {
  opsJournalSession?: { sessionId: string };
};

/**
 * Additive auth for the ops-journal write surface: accepts a session-scoped
 * journal-write credential (loopback-only, restricted by the route handler
 * to the staging transitions — never -> resolved) or, when no such
 * credential is presented, falls through unchanged to requireDeviceAuth so
 * the existing device-authed interactive /ops path keeps full access.
 */
export function requireOpsJournalWriteAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = getBearerToken(req);
  if (token) {
    const cred = credentialsByToken.get(token);
    if (cred) {
      const remoteAddr = req.socket.remoteAddress ?? '';
      if (!isLoopbackIp(remoteAddr)) {
        res
          .status(403)
          .json({ error: 'forbidden', code: 'ops_journal_loopback_only' });
        return;
      }
      (req as OpsJournalWriteAuthedRequest).opsJournalSession = {
        sessionId: cred.sessionId,
      };
      next();
      return;
    }
  }
  requireDeviceAuth(req, res, next);
}
