import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGrantedCapabilities } from '../../db/queries';
import {
  AUDIT_LOG_ROW_CAP,
  queryAuditLogByProject,
} from '../../audit/AuditLog';
import { auditLogReadCapability } from '../../session/orchestrator-config';

/** Per-connection context the audit-log-read tool is scoped to. */
export interface AuditLogReadToolContext {
  sessionId: string;
}

/**
 * Registers `auditLog.query` — the Tier-B (capability-gated) half of the
 * read-only MCP surface (see the design task "Design the read-only MCP
 * surface..."): a project-scoped read over the orchestrator's own
 * `audit_log` table, optionally narrowed by task id / event type / a
 * `[since, until]` ts window. Backed by `queryAuditLogByProject`
 * (audit/AuditLog.ts), which uses `idx_audit_log_project_task`
 * (db/schema.ts) so a project-scoped query doesn't table-scan.
 *
 * Gated behind a durable grant naming this exact project id
 * (`getGrantedCapabilities(sessionId).includes(auditLogReadCapability(projectId))`)
 * — the same shape as `session.getRecord`'s own-record-read grant, but
 * parameterized by project rather than target session. A grant for the
 * requesting session's own dispatched project auto-approves at stage time
 * (see `session/orchestrator-config.ts#isSanctionedAutoApproveCapability`);
 * any other project's grant parks for operator approval as usual.
 *
 * Always-on rather than workflow-gated, same precedent as
 * `session.getRecord` — the grant check is the sole gate.
 */
export function registerAuditLogReadTools(
  server: McpServer,
  ctx: AuditLogReadToolContext,
): void {
  server.registerTool(
    'auditLog.query',
    {
      title: "Query one project's audit log",
      description:
        'Read-only: returns audit_log rows for `projectId`, optionally narrowed by ' +
        '`taskId` / `eventType` / a `[since, until]` ts window (epoch ms, inclusive). ' +
        `Capped at \`limit\` (max ${AUDIT_LOG_ROW_CAP}, default ${AUDIT_LOG_ROW_CAP}) rows, ` +
        'returning the most recent matching rows; check `matchedCount` against ' +
        '`entries.length` to detect truncation. Requires a durable grant naming this ' +
        'exact project id — request it via `session.requestCapability` with capability ' +
        "`read:audit-log:<projectId>` (auto-approved when `<projectId>` is this session's " +
        'own dispatched project). An empty `entries` array alone does not mean the event ' +
        'never happened: check `unattributedCount` (matching rows exist but carry no ' +
        'project_id — some event types are never project-attributed) and ' +
        '`eventTypeRecognized` (false means the `eventType` name matches no row anywhere, ' +
        'i.e. it is unrecognized or retired).',
      inputSchema: {
        projectId: z.string(),
        taskId: z.string().optional(),
        eventType: z.string().optional(),
        since: z.number().optional(),
        until: z.number().optional(),
        limit: z.number().int().positive().max(AUDIT_LOG_ROW_CAP).optional(),
      },
    },
    async (args) => {
      const capability = auditLogReadCapability(args.projectId);
      const granted = getGrantedCapabilities(ctx.sessionId);
      if (!granted.includes(capability)) {
        throw new Error(
          `capability not granted: "${capability}" — request it via session.requestCapability first`,
        );
      }

      const result = queryAuditLogByProject(
        args.projectId,
        {
          taskId: args.taskId,
          eventType: args.eventType,
          since: args.since,
          until: args.until,
        },
        args.limit ?? AUDIT_LOG_ROW_CAP,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  );
}
