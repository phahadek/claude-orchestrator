import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { isLoopbackIp, requireDeviceAuth } from './DeviceAuth';
import { getDataDir } from '../config/dataDir';
import { recordEvent } from '../audit/AuditLog';
import type { AuditEvent } from '../audit/types';
import { getGrantedCapabilities } from '../db/queries';
import {
  isGrantable,
  isToolShapedCapability,
} from '../session/orchestrator-config';

/**
 * Instrumentation must never fail the request it observes — mirrors
 * SessionStageAuth.ts's safeRecordEvent.
 */
function safeRecordEvent(event: AuditEvent): void {
  try {
    recordEvent(event);
  } catch {
    // Best-effort only.
  }
}

/**
 * Per-session scoped credential authorizing the sanctioned route-client
 * surface (ops-client.mjs, groom-context-client.mjs, design-context-client.mjs,
 * gate-state-client.mjs, seed-state-client.mjs, staged-intents-client.mjs,
 * task-abort-client.mjs, groom-flip-client.mjs) — every vendored script that
 * today authenticates with the shared, human-operator $ORCHESTRATOR_DEVICE_TOKEN
 * against a `requireDeviceAuth`-gated route. A dispatched session has no
 * device token by design (see CliSessionRunner.ts), so an operator-granted
 * `Bash(node packages/backend/scripts/<x>-client.mjs ...)` capability ran and
 * died at auth — this credential closes that gap without handing the session
 * the shared device token (the wrong shape: it authorizes everything, forever,
 * for every device, not this one session's one approved action).
 *
 * Deliberately NOT the same credential as SessionStageAuth's stage token: the
 * stage token authenticates the loopback MCP/stage surface
 * (`requireSessionStageAuth`), a different auth class than the device-authed
 * REST surface these scripts call (`requireDeviceAuth`) — an RC session's
 * device token is already rejected by the stage endpoint, and the reverse is
 * true here: the stage token is never accepted on a device-authed route.
 *
 * Mirrors SessionStageAuth.ts's mint/persist/revoke/idempotency shape
 * (idempotent per session, persisted to survive a backend restart, revoked at
 * teardown) but keeps a wholly separate token namespace and on-disk mirror —
 * a session's stage token and route token are unrelated values.
 */
interface RouteCredential {
  sessionId: string;
  createdAt: number;
}

const credentialsByToken = new Map<string, RouteCredential>();
const tokenBySession = new Map<string, string>();

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

/** On-disk mirror of the maps above — survives a backend restart, same rationale as SessionStageAuth.ts's mirror. */
function credentialsFilePath(): string {
  return path.join(getDataDir(), 'session-route-credentials.json');
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
    // Best-effort — see SessionStageAuth.ts's persistCredentials.
  }
}

function loadPersistedCredentials(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(credentialsFilePath(), 'utf-8');
  } catch {
    return;
  }
  try {
    const entries = JSON.parse(raw) as Array<
      RouteCredential & { token: string }
    >;
    for (const { token, sessionId, createdAt } of entries) {
      credentialsByToken.set(token, { sessionId, createdAt });
      tokenBySession.set(sessionId, token);
    }
  } catch {
    // Corrupt file — start from whatever's already in memory.
  }
}

loadPersistedCredentials();

function reloadAndLookupBySession(sessionId: string): string | undefined {
  loadPersistedCredentials();
  return tokenBySession.get(sessionId);
}

/**
 * Mint (or return the existing) route credential for a session. Idempotent
 * across resumes/escalations — including a resume after a backend restart —
 * so a session keeps exactly one route token for its life, matching
 * mintStageCredential's guarantee.
 */
export function mintRouteCredential(sessionId: string): string {
  const existing =
    tokenBySession.get(sessionId) ?? reloadAndLookupBySession(sessionId);
  if (existing) return existing;
  const token = randomUUID();
  tokenBySession.set(sessionId, token);
  credentialsByToken.set(token, { sessionId, createdAt: Date.now() });
  persistCredentials();
  return token;
}

/** Revoke a session's route credential. Safe to call multiple times. */
export function revokeRouteCredential(
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
    event_type: 'route_session_credential_revoked',
    actor_type: 'system',
    actor_id: sessionId,
    payload: { sessionId, reason },
  });
}

function validateRouteCredential(token: string): { sessionId: string } | null {
  const cred = credentialsByToken.get(token);
  if (cred) return { sessionId: cred.sessionId };
  loadPersistedCredentials();
  const reloaded = credentialsByToken.get(token);
  return reloaded ? { sessionId: reloaded.sessionId } : null;
}

/**
 * Directory the per-session route-credential delivery file is written
 * under — `<app-data-dir>/session-route-credentials/`, deliberately outside
 * any project checkout or worktree, mirroring mcpConfigDir() in
 * SessionManager.ts. The route-client scripts read their token from this
 * file (see routeCredentialFilePath) rather than from an env var, keeping
 * CliSessionRunner's deliberate production-env stripping intact — only the
 * file *path* crosses into the child's env, never the secret itself.
 */
function routeCredentialDir(): string {
  return path.join(
    process.env.MCP_CONFIG_DIR || getDataDir(),
    'session-route-credentials',
  );
}

/** Deterministic delivery-file path for a session's route credential. Pure — no side effects. */
export function routeCredentialFilePath(sessionId: string): string {
  return path.join(routeCredentialDir(), `${sessionId}.token`);
}

/**
 * Mint (idempotent) and write a session's route credential to its delivery
 * file, returning the file path. Called at every (re)spawn, mirroring
 * writeMcpConfig — the file's content is stable across calls since minting
 * is idempotent, so rewriting on every spawn is harmless.
 */
export function writeRouteCredentialFile(sessionId: string): string {
  const token = mintRouteCredential(sessionId);
  const dir = routeCredentialDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = routeCredentialFilePath(sessionId);
  fs.writeFileSync(filePath, token, { encoding: 'utf-8', mode: 0o600 });
  return filePath;
}

/**
 * Maps a sanctioned route-client script's basename to the request paths it
 * is allowed to authorize a session credential for. A session's route
 * credential authorizes a request only when the session currently holds a
 * grantable, tool-shaped `Bash(...)` capability that names the script (see
 * isGrantable/isToolShapedCapability, orchestrator-config.ts) AND the
 * request path matches that script's route family — the scoping recommended
 * by grooming: "scoped to the operations the granting capability named,"
 * approximated at script-family granularity rather than full per-subcommand
 * parsing (the CLI's own --allowed-tools prefix match, unchanged by this
 * module, is still what restricts exactly which shell command the session
 * can run in the first place).
 */
const CLIENT_SCRIPT_ROUTE_RULES: ReadonlyArray<{
  script: string;
  pathPattern: RegExp;
}> = [
  // Exact match only — deliberately excludes POST /api/ops-journal/:taskId/state,
  // the one write this route family exposes. That write stays device-only:
  // a dispatched session drives its ops_journal forward through the
  // orchestrator MCP tool surface's `journal.setState` instead (see
  // opsJournal.ts's doc comment) — the session-scoped credential this route
  // used to accept for that write was deliberately retired, and this task
  // does not reopen it.
  { script: 'ops-client.mjs', pathPattern: /^\/api\/ops-(context|journal)$/ },
  {
    script: 'groom-context-client.mjs',
    pathPattern: /^\/api\/groom-context(\/|$)/,
  },
  {
    script: 'design-context-client.mjs',
    pathPattern: /^\/api\/design-context(\/|$)/,
  },
  { script: 'gate-state-client.mjs', pathPattern: /^\/api\/gate(\/|$)/ },
  { script: 'seed-state-client.mjs', pathPattern: /^\/api\/seed(\/|$)/ },
  {
    script: 'staged-intents-client.mjs',
    pathPattern: /^\/api\/staged-intents(\/|$)/,
  },
  {
    script: 'task-abort-client.mjs',
    pathPattern: /^\/api\/tasks\/[^/]+\/abort$/,
  },
  { script: 'groom-flip-client.mjs', pathPattern: /^\/api\/groom\/flip$/ },
];

/**
 * True iff `sessionId` currently holds a grantable, tool-shaped Bash
 * capability naming a client script whose route family covers `reqPath`.
 */
export function isRouteAuthorizedForSession(
  sessionId: string,
  reqPath: string,
): boolean {
  const granted = getGrantedCapabilities(sessionId)
    .filter(isGrantable)
    .filter(isToolShapedCapability);
  if (granted.length === 0) return false;
  return CLIENT_SCRIPT_ROUTE_RULES.some(
    ({ script, pathPattern }) =>
      pathPattern.test(reqPath) && granted.some((cap) => cap.includes(script)),
  );
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/**
 * Combined auth middleware for the device-authed `/api` surface: accepts the
 * existing device token exactly as `requireDeviceAuth` already does (that
 * path is untouched — human/RC-session callers see no behavior change), or a
 * session route credential scoped to the requesting session's currently
 * granted capabilities. Falls through to `requireDeviceAuth` (and its
 * bootstrap/loopback handling) for any bearer token that isn't a recognized,
 * in-scope route credential, so error responses for a bad/missing device
 * token are unchanged.
 */
export function requireDeviceOrSessionRouteAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = getBearerToken(req);
  if (token) {
    const cred = validateRouteCredential(token);
    if (cred) {
      const remoteAddr = req.socket.remoteAddress ?? '';
      if (!isLoopbackIp(remoteAddr)) {
        res
          .status(403)
          .json({ error: 'forbidden', code: 'route_credential_loopback_only' });
        return;
      }
      if (!isRouteAuthorizedForSession(cred.sessionId, req.path)) {
        safeRecordEvent({
          event_type: 'route_session_credential_rejected',
          actor_type: 'system',
          actor_id: cred.sessionId,
          payload: {
            sessionId: cred.sessionId,
            reason: 'out_of_scope',
            method: req.method,
            path: req.path,
          },
        });
        res
          .status(403)
          .json({ error: 'forbidden', code: 'route_credential_out_of_scope' });
        return;
      }
      (req as Request & { routeSession: { sessionId: string } }).routeSession =
        cred;
      next();
      return;
    }
    const attribution = revokedTokenAttribution.get(token);
    if (attribution) {
      safeRecordEvent({
        event_type: 'route_session_credential_rejected',
        actor_type: 'system',
        actor_id: attribution.sessionId,
        payload: {
          sessionId: attribution.sessionId,
          reason: 'revoked',
          method: req.method,
          path: req.path,
        },
      });
    }
  }
  requireDeviceAuth(req, res, next);
}

/** Test-only: reset all in-memory credential state. */
export function _resetRouteCredentialsForTesting(): void {
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
 * maps while leaving the on-disk mirror untouched.
 */
export function _simulateRouteCredentialProcessRestartForTesting(): void {
  credentialsByToken.clear();
  tokenBySession.clear();
}
