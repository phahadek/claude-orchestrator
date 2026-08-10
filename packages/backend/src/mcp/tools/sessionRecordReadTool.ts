import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getSession,
  getSessionAsOf,
  getEventsBySession,
  getGrantedCapabilities,
} from '../../db/queries';
import { getAuditLogByActorId } from '../../audit/AuditLog';
import { sessionRecordReadCapability } from '../../session/orchestrator-config';
import { isSystemOnlyUserEvent } from '../../utils/eventFilters';
import { eventKind } from '../../session/eventKind';

/** Per-connection context the session-record-read tool is scoped to. */
export interface SessionRecordReadToolContext {
  sessionId: string;
}

/**
 * Registers `session.getRecord` — the MCP-tool successor to the vendored
 * `read-session-record.mjs` client (retired: this tool is now the sole
 * sanctioned session-side transport for the read), which fronted
 * `GET /api/session-record-reads/:targetSessionId`
 * (routes/sessionRecordRead.ts). Materialises the one
 * grantable own-record read capability (see
 * `session/orchestrator-config.ts#sessionRecordReadCapability`) — the
 * orchestrator's own runtime records (session_events + audit_log) for a
 * single named target session id — as a tool call instead of a loopback
 * REST round trip.
 *
 * Performs the identical authorization check the retired route did: the
 * connecting session must hold a durable, operator-approved (or
 * auto-approved) grant naming this exact target session id
 * (`getGrantedCapabilities(sessionId).includes(sessionRecordReadCapability(targetSessionId))`).
 * No grant, no read — this tool never falls back to serving the record
 * anyway; it returns a tool-level error instead.
 *
 * Always-on rather than workflow-gated: any dispatched session (planning or
 * code/review) can hold the underlying grant, so the tool itself is
 * registered unconditionally and the grant check is the sole gate.
 */
export function registerSessionRecordReadTool(
  server: McpServer,
  ctx: SessionRecordReadToolContext,
): void {
  server.registerTool(
    'session.getRecord',
    {
      title: "Read one session's own runtime record",
      description:
        'Read-only: returns { session, events, auditLog } for `targetSessionId`, the ' +
        "orchestrator's own runtime record (session_events + audit_log). Requires a " +
        'durable grant naming this exact target session id — request it via ' +
        '`session.requestCapability` with capability `read:session-record:<targetSessionId>`. ' +
        'Optional `asOf` (ISO timestamp) reconstructs the record as of that time instead of ' +
        'reading current state: events/auditLog are filtered to entries at or before `asOf`, ' +
        'and `session.status` comes back as an { __unreconstructable: true, reason } marker ' +
        "instead of the live value (no per-field history yet — see queries.ts's asOf module header).",
      inputSchema: { targetSessionId: z.string(), asOf: z.string().optional() },
    },
    async (args) => {
      const capability = sessionRecordReadCapability(args.targetSessionId);
      const granted = getGrantedCapabilities(ctx.sessionId);
      if (!granted.includes(capability)) {
        throw new Error(
          `capability not granted: "${capability}" — request it via session.requestCapability first`,
        );
      }

      const session = args.asOf
        ? getSessionAsOf(args.targetSessionId, args.asOf)
        : getSession(args.targetSessionId);
      if (!session) {
        throw new Error(`session not found: "${args.targetSessionId}"`);
      }

      const asOfMs = args.asOf ? Date.parse(args.asOf) : undefined;
      const events = getEventsBySession(args.targetSessionId)
        .filter((ev) => !isSystemOnlyUserEvent(ev.payload))
        .filter((ev) => asOfMs === undefined || ev.timestamp <= asOfMs)
        .map((ev) => ({
          eventType: eventKind(ev),
          content: ev.payload,
          timestamp: ev.timestamp,
          ...(ev.message_id != null && { messageId: ev.message_id }),
        }));
      const auditLog = getAuditLogByActorId(args.targetSessionId).filter(
        (entry) => asOfMs === undefined || entry.ts <= asOfMs,
      );

      return {
        content: [
          { type: 'text', text: JSON.stringify({ session, events, auditLog }) },
        ],
      };
    },
  );
}
