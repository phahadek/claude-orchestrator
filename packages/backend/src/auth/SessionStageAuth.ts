import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { isLoopbackIp } from './DeviceAuth';
import { getDataDir } from '../config/dataDir';
import { recordEvent } from '../audit/AuditLog';
import type { AuditEvent } from '../audit/types';

/**
 * Instrumentation must never fail the request it observes — a recordEvent
 * failure (e.g. a transient DB error) is swallowed here rather than left to
 * propagate into the auth/MCP request path.
 */
function safeRecordEvent(event: AuditEvent): void {
  try {
    recordEvent(event);
  } catch {
    // Best-effort only — see doc comment above.
  }
}

/**
 * Per-session scoped stage credential: minted once per session at spawn,
 * injected into the session's spawn env, and only ever accepted by the
 * loopback-only stage endpoint (POST /api/task-intents) and the orchestrator
 * MCP endpoint (POST /api/mcp). It authorizes staging a task-write intent
 * (never applying one) and the session's own read-only MCP tool surface. See
 * Technical Architecture § Task-Write Command Vocabulary & Transport.
 */
interface StageCredential {
  sessionId: string;
  createdAt: number;
}

const credentialsByToken = new Map<string, StageCredential>();
const tokenBySession = new Map<string, string>();

/**
 * Short-lived, in-memory-only record of which session a just-revoked token
 * belonged to — kept so a later request that presents that now-invalid
 * token can still be attributed to a session in the rejection event's
 * payload, distinguishing "this credential was valid and then revoked/
 * expired" from "this token never existed at all." Deliberately not
 * persisted to disk (advisory only, for correlating a rejection with the
 * session it happened to, not for auth decisions) and capped so a long-lived
 * process doesn't grow this unbounded.
 */
const revokedTokenAttribution = new Map<
  string,
  { sessionId: string; revokedAt: number }
>();
const MAX_REVOKED_ATTRIBUTION = 500;

function rememberRevokedToken(token: string, sessionId: string): void {
  revokedTokenAttribution.set(token, { sessionId, revokedAt: Date.now() });
  if (revokedTokenAttribution.size > MAX_REVOKED_ATTRIBUTION) {
    const oldestKey = revokedTokenAttribution.keys().next().value;
    if (oldestKey !== undefined) revokedTokenAttribution.delete(oldestKey);
  }
}

/**
 * On-disk mirror of the maps above, under the app data dir (mode 600 — same
 * protection as the per-session mcp config file that carries this same
 * token). A dispatched session's CLI process runs detached from the backend
 * for the session's full lifetime (see DockerSessionRunner), holding its
 * stage token in an mcp config file written once at spawn — but the maps
 * above previously lived only in this process's memory. A backend restart
 * (deploy) wiped them while every live session's process kept presenting its
 * now-unrecognized token, turning every in-flight and future MCP call for
 * that session into a permanent 401 until its *next* spawn re-minted a token
 * the already-running process never sees mid-turn. Persisting this mirror —
 * and reloading it both at process start and on a validation miss (see
 * validateStageCredential) — closes that gap: the same token/session pairing
 * survives the restart and the credential validates without the model ever
 * observing an error to retry.
 */
function credentialsFilePath(): string {
  return path.join(getDataDir(), 'session-stage-credentials.json');
}

function persistCredentials(): void {
  try {
    const dir = getDataDir();
    fs.mkdirSync(dir, { recursive: true });
    const entries = Array.from(credentialsByToken.entries()).map(
      ([token, cred]) => ({ token, ...cred }),
    );
    fs.writeFileSync(credentialsFilePath(), JSON.stringify(entries), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    // Best-effort: the credential still validates for the rest of this
    // process's lifetime from the in-memory maps; only a restart before the
    // next successful write would lose it.
  }
}

/** Repopulates the in-memory maps from disk without clearing existing entries. */
function loadPersistedCredentials(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(credentialsFilePath(), 'utf-8');
  } catch {
    return; // No file yet — nothing persisted.
  }
  try {
    const entries = JSON.parse(raw) as Array<
      StageCredential & { token: string }
    >;
    for (const { token, sessionId, createdAt } of entries) {
      credentialsByToken.set(token, { sessionId, createdAt });
      tokenBySession.set(sessionId, token);
    }
  } catch {
    // Corrupt file — start from whatever's already in memory.
  }
}

// Load once at process start so a restarted backend recognizes every
// still-live session's token immediately, before its first request.
loadPersistedCredentials();

/** Reloads the on-disk mirror and returns the token now on file for `sessionId`, if any. */
function reloadAndLookupBySession(sessionId: string): string | undefined {
  loadPersistedCredentials();
  return tokenBySession.get(sessionId);
}

/**
 * Mint (or return the existing) stage credential for a session. Idempotent
 * across resumes/escalations — including a resume after a backend
 * restart — so a session keeps exactly one token for its lifetime; a resume
 * that minted a *different* token would desync the running process's
 * already-written mcp config file from the server's idea of the credential.
 */
export function mintStageCredential(sessionId: string): string {
  const existing =
    tokenBySession.get(sessionId) ?? reloadAndLookupBySession(sessionId);
  if (existing) return existing;
  const token = randomUUID();
  tokenBySession.set(sessionId, token);
  credentialsByToken.set(token, { sessionId, createdAt: Date.now() });
  persistCredentials();
  return token;
}

/**
 * Revoke a session's stage credential. Safe to call multiple times.
 *
 * Records `mcp_session_credential_revoked` — the durable signal that this
 * session's orchestrator MCP access has ended server-side (session
 * teardown, a stale in-memory entry reconciled away, etc.) — naming the
 * session id and `reason` so it correlates with sessions/session_events.
 * The token→session mapping is stashed in `revokedTokenAttribution` before
 * it's dropped, so a subsequent request that still presents this token can
 * be attributed back to this session in its own rejection event (see
 * requireSessionStageAuth) rather than looking indistinguishable from a
 * token that was never minted at all.
 */
export function revokeStageCredential(
  sessionId: string,
  reason: string = 'revoked',
): void {
  const token = tokenBySession.get(sessionId);
  if (!token) return;
  tokenBySession.delete(sessionId);
  credentialsByToken.delete(token);
  rememberRevokedToken(token, sessionId);
  persistCredentials();
  safeRecordEvent({
    event_type: 'mcp_session_credential_revoked',
    actor_type: 'system',
    actor_id: sessionId,
    payload: { sessionId, reason },
  });
}

/**
 * Look up the session bound to a stage credential token, or null if
 * invalid/revoked. A miss reloads the on-disk mirror once before declaring
 * the token invalid — self-healing a process restart (or any other loss of
 * the in-memory entry) inside this single validation call, rather than
 * surfacing an error the caller has to interpret and retry.
 */
function validateStageCredential(token: string): { sessionId: string } | null {
  const cred = credentialsByToken.get(token);
  if (cred) return { sessionId: cred.sessionId };
  loadPersistedCredentials();
  const reloaded = credentialsByToken.get(token);
  return reloaded ? { sessionId: reloaded.sessionId } : null;
}

/** Test-only: reset all in-memory credential state. */
export function _resetStageCredentialsForTesting(): void {
  credentialsByToken.clear();
  tokenBySession.clear();
  try {
    fs.rmSync(credentialsFilePath(), { force: true });
  } catch {
    // Nothing persisted yet — fine.
  }
}

/**
 * Test-only: simulates a backend process restart by dropping the in-memory
 * maps while leaving the on-disk mirror untouched — the same state a freshly
 * booted process starts from before its own module-load `loadPersistedCredentials()`
 * call (or a subsequent validation-time self-heal) repopulates them.
 */
export function _simulateProcessRestartForTesting(): void {
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
    // An absent credential never resolves to any session — exempt from the
    // project_id requirement (same accepted precedent as process_boot, see
    // AuditLog.ts#resolveProjectId), but still recorded so it's distinct
    // from a rejected/expired one below.
    safeRecordEvent({
      event_type: 'mcp_stage_credential_rejected',
      actor_type: 'system',
      payload: { reason: 'absent', path: req.path },
    });
    res
      .status(401)
      .json({ error: 'unauthorized', code: 'stage_credential_required' });
    return;
  }

  const session = validateStageCredential(token);
  if (!session) {
    // Distinct, queryable record of an unrecoverable credential rejection —
    // a transport/auth failure must never be indistinguishable in the audit
    // trail from a tool call that legitimately found nothing (see
    // auditLog.query, mcp/tools/auditLogReadTools.ts). When the token was
    // minted and later revoked (see revokeStageCredential), attribute it
    // back to that session — carrying a real project_id — rather than
    // lumping it in with a token that was never minted at all.
    const attribution = revokedTokenAttribution.get(token);
    safeRecordEvent({
      event_type: 'mcp_stage_credential_rejected',
      actor_type: 'system',
      actor_id: attribution?.sessionId ?? null,
      payload: {
        reason: attribution ? 'revoked' : 'unknown',
        tokenPrefix: token.slice(0, 8),
        path: req.path,
        ...(attribution ? { sessionId: attribution.sessionId } : {}),
      },
    });
    res
      .status(401)
      .json({ error: 'unauthorized', code: 'invalid_stage_credential' });
    return;
  }

  (req as Request & { stageSession: { sessionId: string } }).stageSession =
    session;
  next();
}
