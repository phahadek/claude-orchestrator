import { Router } from 'express';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireSessionStageAuth } from '../auth/SessionStageAuth';
import { getSession } from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import type { AuditEvent } from '../audit/types';
import { registerStageProposalTools } from './tools/stageProposalTools';
import { registerVerdictTools } from './tools/verdictTools';
import { registerGateReclassifyTool } from './tools/gateReclassifyTool';
import { registerStrandedIntentTool } from './tools/strandedIntentTool';
import { registerCompletenessTools } from './tools/completenessTools';
import { registerGroomPrecheckTool } from './tools/groomPrecheckTool';
import { registerArchitectureReadTools } from './tools/architectureReadTools';
import { registerTaskReadTools } from './tools/taskReadTools';
import { registerPullRequestReadTools } from './tools/pullRequestReadTools';
import { registerGateSeedReadTools } from './tools/gateSeedReadTools';
import { registerTestHealthReadTools } from './tools/testHealthReadTools';
import { registerSessionRecordReadTool } from './tools/sessionRecordReadTool';
import { registerAuditLogReadTools } from './tools/auditLogReadTools';
import { registerSessionEventsReadTools } from './tools/sessionEventsReadTools';
import type { SessionManager } from '../session/SessionManager';
import {
  PLANNING_INTENT_KINDS,
  CODE_INTENT_KINDS,
  INVESTIGATE_INTENT_KINDS,
} from '../planning/planningIntentKinds';
import type { PlanningWorkflow } from '../planning/planningIntentKinds';
import { resolveMilestoneForSessionTask } from '../projects/milestoneResolver';
import { normalizeTaskId, parseTaskId } from '../tasks/taskId';
import { isInvestigateSession } from '../session/sessionPredicates';

const NOTION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A task id is well-formed when it normalizes to a recognized
 * `source:externalId` pair (see `taskId.ts`) whose Notion external id is a
 * real 32-hex UUID — rejecting the hand-transcription slips a session hits
 * copying an id off a slugified Notion URL (a dropped/extra hex digit, a
 * missing/garbled `notion:` prefix, wrong hyphenation) rather than passing
 * them through to a provider 400.
 */
function isWellFormedTaskId(taskId: unknown): taskId is string {
  if (typeof taskId !== 'string' || !taskId.trim()) return false;
  let parsed;
  try {
    parsed = parseTaskId(normalizeTaskId(taskId));
  } catch {
    return false;
  }
  return parsed.source === 'notion'
    ? NOTION_UUID_RE.test(parsed.externalId)
    : true;
}

/** Pulls the `taskId` a tool call carries, whether top-level or nested under `payload`. */
function extractTaskId(args: unknown): unknown {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  if ('taskId' in record) return record.taskId;
  const payload = record.payload;
  if (payload && typeof payload === 'object' && 'taskId' in payload) {
    return (payload as Record<string, unknown>).taskId;
  }
  return undefined;
}

/**
 * Wraps every tool registered on `server` from this point on so a
 * malformed `taskId` argument (top-level or under `payload`) is rejected
 * before the handler runs — before it ever reaches a provider call — with
 * a message naming this connection's own bound task id, so a session that
 * mistyped its only usable identifier is told what it actually is instead
 * of just that the one it sent is invalid. A well-formed taskId for a task
 * other than the session's own is never rejected or rewritten — staging
 * against another task is sometimes legitimate; only shape is checked here.
 */
function guardTaskIdArguments(
  server: McpServer,
  boundTaskId: string | null,
): void {
  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((name: unknown, config: unknown, handler: unknown) => {
    if (typeof handler !== 'function') {
      return (originalRegisterTool as (...args: unknown[]) => unknown)(
        name,
        config,
        handler,
      );
    }
    const wrapped = async (...handlerArgs: unknown[]) => {
      const taskId = extractTaskId(handlerArgs[0]);
      if (taskId !== undefined && !isWellFormedTaskId(taskId)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text:
                `taskId ${JSON.stringify(taskId)} is not a well-formed task id. ` +
                `This session is bound to ${boundTaskId ? JSON.stringify(boundTaskId) : 'no task'} — ` +
                'if you meant that task, pass it verbatim; do not hand-transcribe or re-hyphenate an id.',
            },
          ],
        };
      }
      return (handler as (...a: unknown[]) => unknown)(...handlerArgs);
    };
    return (originalRegisterTool as (...args: unknown[]) => unknown)(
      name,
      config,
      wrapped,
    );
  }) as typeof server.registerTool;
}

/**
 * Maps a session's `session_type` to its planning workflow, or null for a
 * session that isn't a planning workflow (standard/review) — the case that
 * keeps the unfiltered stage-proposal surface and the full verdict surface.
 */
function toPlanningWorkflow(
  sessionType: string | undefined,
): PlanningWorkflow | null {
  return sessionType === 'groom' ||
    sessionType === 'design' ||
    sessionType === 'ops' ||
    sessionType === 'split'
    ? sessionType
    : null;
}

/**
 * Resolves the stage-proposal kinds registered on a connection. An
 * investigate-dispatched session (session_type 'ops', task_id
 * `report-batch:<batchId>` — see sessionPredicates.ts#isInvestigateSession)
 * gets `INVESTIGATE_INTENT_KINDS`, not `PLANNING_INTENT_KINDS.ops`: it has
 * no journal/task-status/gate/PR-intent analog, and needs `decision.pickOne`,
 * which `PLANNING_INTENT_KINDS.ops` lacks. A null workflow (code/review
 * sessions) registers CODE_INTENT_KINDS, not every kind — see
 * planningIntentKinds.ts.
 */
function resolveStageProposalKinds(
  workflow: PlanningWorkflow | null,
  taskId: string | null | undefined,
): readonly string[] {
  if (workflow === 'ops' && isInvestigateSession(taskId)) {
    return INVESTIGATE_INTENT_KINDS;
  }
  return workflow ? PLANNING_INTENT_KINDS[workflow] : CODE_INTENT_KINDS;
}

/**
 * Instrumentation must never fail the MCP request it observes — a
 * recordEvent failure (e.g. a transient DB error) is swallowed here rather
 * than left to propagate into the request path.
 */
function safeRecordEvent(event: AuditEvent): void {
  try {
    recordEvent(event);
  } catch {
    // Best-effort only — see doc comment above.
  }
}

/** Path the router registers, relative to where it's mounted (see server.ts: app.use('/api', ...)). */
const ORCHESTRATOR_MCP_PATH = '/mcp';

/** Full path as reachable from the backend root, for building the session's MCP config URL. */
const ORCHESTRATOR_MCP_FULL_PATH = `/api${ORCHESTRATOR_MCP_PATH}`;

/** Name of the MCP server entry injected into a dispatched session's config. */
export const ORCHESTRATOR_MCP_SERVER_NAME = 'orchestrator';

/**
 * Builds the `{ type, url, headers }` entry injected into a dispatched
 * session's MCP config, carrying its per-session stage credential as the
 * bearer token. See writeMcpConfig in SessionManager.ts for the merge with
 * per-project mcp_servers.
 */
export function buildOrchestratorMcpServerEntry(
  port: number,
  stageToken: string,
): Record<string, unknown> {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}${ORCHESTRATOR_MCP_FULL_PATH}`,
    headers: { Authorization: `Bearer ${stageToken}` },
  };
}

/**
 * Builds the McpServer instance for one connection, registering the health
 * handshake tool, the stage-proposal tool surface when the connecting
 * session resolves to a project (one tool per staged-intent kind, see
 * mcp/tools/stageProposalTools.ts), and the verdict-delivery tool surface
 * (gate.verify / review.disposition / flaky.confirm, see
 * mcp/tools/verdictTools.ts) scoped to this session's live AgentSession, the
 * 'ops'-scoped gate-item reclassification verb (gate.reclassify, see
 * mcp/tools/gateReclassifyTool.ts — the authenticated-MCP replacement for
 * the device-authed gate-state-client.mjs `reclassify` command) and the
 * 'ops'-scoped stranded-intent disposition verb (intent.dispositionStranded,
 * see mcp/tools/strandedIntentTool.ts), both acting immediately rather than
 * staging an intent for later operator disposition — none of gate.verify /
 * deploy.verdict / gate.reclassify / intent.dispositionStranded are
 * registered for an investigate-dispatched session (session_type 'ops',
 * task_id `report-batch:<batchId>`, see
 * sessionPredicates.ts#isInvestigateSession): it has no gate item or PR to
 * act on, so these fall back to their workflow=null (unregistered) case,
 * — for a 'design' workflow session — the completeness-safeguard direct-
 * write/read surface (completeness.disposition / completeness.traceCoverage,
 * see mcp/tools/completenessTools.ts), and — for a 'groom' workflow session
 * resolving to a project — the read-only Ready-flip-payload precheck
 * (groom.precheck, see mcp/tools/groomPrecheckTool.ts), and — for a
 * 'groom' / 'design' / 'ops' workflow session — the read-only arch_unit
 * store surface (architecture.getUnit / architecture.queryUnits, see
 * mcp/tools/architectureReadTools.ts), always-on rather than grant-gated
 * since architecture content is these workflows' non-negotiable input —
 * and the read-only task-summary lookup (task.getById, see
 * mcp/tools/taskReadTools.ts), same always-on precedent, for a task id
 * outside the session's injected digest — and, for ANY session resolving to
 * a project (not workflow-gated, since verify/investigation sessions run
 * under session_type standard/review with workflow=null), the read-only
 * pull-request lookup (pullRequest.getByTaskId, see
 * mcp/tools/pullRequestReadTools.ts) and the read-only gate/seed item state
 * lookup (gateSeed.getState, see mcp/tools/gateSeedReadTools.ts) which never
 * exposes gate_item_event/seed_item_event rows or their operator column.
 * Also always-on: the Tier-B (capability-gated) read surface —
 * session.getRecord (see mcp/tools/sessionRecordReadTool.ts),
 * auditLog.query (see mcp/tools/auditLogReadTools.ts), and
 * sessionEvents.query (see mcp/tools/sessionEventsReadTools.ts) —
 * registered unconditionally since each call's grant check, not
 * connection-time session type, is the sole gate.
 */
export function buildMcpServer(
  sessionId: string,
  sessionManager: SessionManager,
): McpServer {
  const server = new McpServer({
    name: 'claude-orchestrator',
    version: '1.0.0',
  });

  const session = getSession(sessionId);
  guardTaskIdArguments(server, session?.task_id ?? null);

  server.registerTool(
    'health',
    {
      title: 'Orchestrator health check',
      description:
        'Handshake tool confirming the MCP connection and session credential are valid.',
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
    }),
  );

  const workflow = toPlanningWorkflow(session?.session_type);
  // gate.verify / deploy.verdict / gate.reclassify / intent.dispositionStranded
  // register directly off `workflow === 'ops'` (verdictTools.ts,
  // gateReclassifyTool.ts, strandedIntentTool.ts) — outside the
  // PLANNING_INTENT_KINDS.ops kinds resolveStageProposalKinds already
  // narrows above. An investigate-dispatched session (session_type 'ops',
  // task_id `report-batch:<batchId>`) has no gate item or PR to act on, so
  // downgrade to `null` here too; the read-only registrations further below
  // remain keyed on `workflow`, unchanged.
  const mutationWorkflow: PlanningWorkflow | null =
    workflow === 'ops' && isInvestigateSession(session?.task_id)
      ? null
      : workflow;

  if (session?.project_id) {
    // Best-effort — a task not found in any cached milestone board (e.g. a
    // non-milestone task) resolves to null, and the intent lands in the
    // "unattributed" bucket rather than blocking staging.
    const milestone = session.task_id
      ? resolveMilestoneForSessionTask(session.project_id, session.task_id)
      : null;
    registerStageProposalTools(server, {
      sessionId,
      projectId: session.project_id,
      kinds: resolveStageProposalKinds(workflow, session.task_id),
      sessionManager,
      milestone,
    });
    registerGroomPrecheckTool(server, {
      projectId: session.project_id,
      workflow,
    });
    registerTaskReadTools(server, {
      projectId: session.project_id,
      workflow,
    });
    registerPullRequestReadTools(server);
    registerGateSeedReadTools(server, { projectId: session.project_id });
    registerTestHealthReadTools(server, { projectId: session.project_id });
    registerCompletenessTools(server, {
      sessionId,
      workflow,
      projectId: session.project_id,
      milestone,
    });
  } else {
    registerCompletenessTools(server, { sessionId, workflow });
  }

  registerVerdictTools(server, {
    sessionId,
    getSession: () => sessionManager.getLiveSession(sessionId),
    workflow: mutationWorkflow,
  });

  registerGateReclassifyTool(server, {
    sessionId,
    workflow: mutationWorkflow,
  });
  registerStrandedIntentTool(server, {
    sessionId,
    workflow: mutationWorkflow,
  });

  if (session?.project_id) {
    registerArchitectureReadTools(server, {
      workflow,
      projectId: session.project_id,
    });
  }

  registerSessionRecordReadTool(server, { sessionId });
  registerAuditLogReadTools(server, { sessionId });
  registerSessionEventsReadTools(server, { sessionId });

  return server;
}

/**
 * Long-lived, loopback-only orchestrator MCP server mounted alongside the
 * existing REST routes (e.g. /api/task-intents), ahead of requireDeviceAuth.
 * Auth is the same per-session stage credential as the task-intents stage
 * endpoint (requireSessionStageAuth) — scope is staging + verdict reporting +
 * read-only architecture lookups, never apply. Runs stateless: each request
 * gets its own transport +
 * server instance, so no MCP-level session store is needed on top of the
 * per-session stage credential that already scopes access.
 */
export function createOrchestratorMcpRouter(
  sessionManager: SessionManager,
): Router {
  const router = Router();

  router.post(
    ORCHESTRATOR_MCP_PATH,
    requireSessionStageAuth,
    async (req: Request, res: Response) => {
      // Each request already gets a fresh transport + server instance (see
      // this router's doc comment) — there is no throughput benefit to
      // pooling the underlying TCP connection for reuse, only the risk of
      // the client reusing a socket the server's default keep-alive timeout
      // (Node's 5s default on the shared http.Server, see server.ts) has
      // silently closed, which the CLI's MCP client surfaces as "session
      // expired". Force a fresh connection per call instead by rewriting
      // the SDK transport's own explicit "Connection: keep-alive" header
      // (set for its SSE-capable response) at the one point guaranteed to
      // run after it: wrapping res.writeHead, since per Node's semantics a
      // header passed directly to writeHead() beats a prior setHeader() call.
      const originalWriteHead = res.writeHead.bind(res);
      res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
        const headersArg = args[args.length - 1];
        if (headersArg && typeof headersArg === 'object') {
          for (const key of Object.keys(headersArg)) {
            if (key.toLowerCase() === 'connection') {
              delete (headersArg as Record<string, unknown>)[key];
            }
          }
        }
        res.setHeader('Connection', 'close');
        return originalWriteHead(...args);
      }) as typeof res.writeHead;
      const { sessionId } = (
        req as Request & { stageSession: { sessionId: string } }
      ).stageSession;

      // Connection-established: the durable record that this session
      // authenticated and reached the MCP mount, keyed to its session id so
      // it correlates with sessions/session_events. Fires identically for a
      // fresh spawn or a --resume'd session — this handler has no notion of
      // spawn-vs-resume, only of the credential presented, so a resumed
      // session's reconnect is captured the same way a first connect is.
      safeRecordEvent({
        event_type: 'mcp_connection_established',
        actor_type: 'system',
        actor_id: sessionId,
        payload: { path: req.path },
      });

      const server = buildMcpServer(sessionId, sessionManager);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
        // Teardown, named with a reason: a response that never finished
        // writing means the client (or the transport) dropped the
        // connection before completion; a >=400 status means the request
        // itself failed; anything else is an ordinary per-call teardown —
        // this transport is stateless, so every request gets its own
        // connect/close pair (see this router's doc comment).
        const reason = !res.writableEnded
          ? 'client_disconnected'
          : res.statusCode >= 400
            ? 'error'
            : 'completed';
        safeRecordEvent({
          event_type: 'mcp_connection_closed',
          actor_type: 'system',
          actor_id: sessionId,
          payload: { reason, statusCode: res.statusCode },
        });
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  // Stateless mode has no server-managed session to stream to or tear down.
  router.get(ORCHESTRATOR_MCP_PATH, requireSessionStageAuth, (_req, res) => {
    res.status(405).json({ error: 'method_not_allowed' });
  });
  router.delete(ORCHESTRATOR_MCP_PATH, requireSessionStageAuth, (_req, res) => {
    res.status(405).json({ error: 'method_not_allowed' });
  });

  return router;
}
