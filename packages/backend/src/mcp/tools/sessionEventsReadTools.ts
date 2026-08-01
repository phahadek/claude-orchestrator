import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getGrantedCapabilities,
  querySessionEventsByProjectAggregate,
  querySessionEventsByProjectRows,
  SESSION_EVENTS_ROW_CAP,
} from '../../db/queries';
import { sessionEventsReadCapability } from '../../session/orchestrator-config';

/** Per-connection context the session-events-read tool is scoped to. */
export interface SessionEventsReadToolContext {
  sessionId: string;
}

/**
 * Registers `sessionEvents.query` — the aggregate, project-scoped sibling
 * of `auditLog.query` (see mcp/tools/auditLogReadTools.ts): a read over the
 * orchestrator's own `session_events` table across every session in one
 * project, answering "has this ever happened, across any session in this
 * project" — a question `session.getRecord`'s single-session
 * `read:session-record:<id>` scope cannot express.
 *
 * Mirrors auditLogReadCapability's authorization and registration wiring
 * exactly: gated behind a durable grant naming this exact project id
 * (`getGrantedCapabilities(sessionId).includes(sessionEventsReadCapability(projectId))`),
 * with the requesting session's own dispatched project auto-approving at
 * stage time (see `session/orchestrator-config.ts#isSanctionedAutoApproveCapability`)
 * and any other project's grant parking for operator approval as usual.
 * Always-on rather than workflow-gated, same precedent as `auditLog.query`
 * — the grant check is the sole gate.
 *
 * Does NOT mirror auditLog.query's return shape or query semantics:
 * session_events payloads are large assistant-turn JSON blobs (a naive
 * project-wide `SELECT *` blew the tool-result size limit — see the task
 * context), so this tool is aggregate-first by default (counts /
 * timestamps grouped by session_id) and only returns payload bodies under
 * an explicit `includePayloads` opt-in bounded by `SESSION_EVENTS_ROW_CAP`.
 * The useful filters also differ: `eventType` is dropped (session_events
 * has only four values, making it a near-useless discriminator) in favor
 * of `pattern`, a substring match against `payload`.
 */
export function registerSessionEventsReadTools(
  server: McpServer,
  ctx: SessionEventsReadToolContext,
): void {
  server.registerTool(
    'sessionEvents.query',
    {
      title: "Query a project's session_events, aggregated across sessions",
      description:
        'Read-only: by default, returns per-session_id counts + first/last timestamp ' +
        "(epoch ms) for `projectId`'s session_events, optionally narrowed by a `pattern` " +
        'substring match against `payload` or a `[since, until]` timestamp window (epoch ' +
        'ms, inclusive). Pass `includePayloads: true` to instead get up to `limit` ' +
        `(max ${SESSION_EVENTS_ROW_CAP}) raw rows including payload bodies. Requires a ` +
        'durable grant naming this exact project id — request it via ' +
        '`session.requestCapability` with capability `read:session-events:<projectId>` ' +
        "(auto-approved when `<projectId>` is this session's own dispatched project).",
      inputSchema: {
        projectId: z.string(),
        pattern: z.string().optional(),
        since: z.number().optional(),
        until: z.number().optional(),
        includePayloads: z.boolean().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(SESSION_EVENTS_ROW_CAP)
          .optional(),
      },
    },
    async (args) => {
      const capability = sessionEventsReadCapability(args.projectId);
      const granted = getGrantedCapabilities(ctx.sessionId);
      if (!granted.includes(capability)) {
        throw new Error(
          `capability not granted: "${capability}" — request it via session.requestCapability first`,
        );
      }

      const filters = {
        pattern: args.pattern,
        since: args.since,
        until: args.until,
      };

      if (args.includePayloads) {
        const rows = querySessionEventsByProjectRows(
          args.projectId,
          filters,
          args.limit,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify({ rows }) }],
        };
      }

      const sessions = querySessionEventsByProjectAggregate(
        args.projectId,
        filters,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({ sessions }) }],
      };
    },
  );
}
