import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentSession } from '../../session/AgentSession';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';
import {
  reviewDispositionSchema,
  flakyGateSchema,
  gateVerifyDispositionSchema,
  gateVerifyEvidenceSchema,
  gateVerifyReclassifySchema,
  gateVerifyPayloadSchema,
  gateVerifyResultSchema,
  deployAgenticVerdictSchema,
} from './schemas';
import {
  getPRBySessionId,
  evaluateTestFlakinessCorpus,
} from '../../db/queries';
import {
  isTestIdTouchedByChangedFiles,
  classnameFromTestId,
} from '../../session/test-runner';
import { getChangedFiles } from '../../session/autofix-runner';
import { typedGetSetting } from '../../config/settings';

/** Per-connection context a verdict-delivery tool call is scoped to. */
export interface VerdictToolContext {
  sessionId: string;
  /** Resolved lazily at call time — a session may not yet be live when the MCP connection is established. */
  getSession: () => AgentSession | undefined;
  /**
   * The connecting session's planning workflow, or null for a
   * non-planning (standard/review) session. review.disposition and
   * flaky.confirm are scoped to non-planning sessions; gate.verify is
   * scoped to 'ops' sessions as a whole, mirroring OPS_MCP_TOOLS in
   * config.ts.
   */
  workflow: PlanningWorkflow | null;
}

function notLive(): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ error: 'session_not_live' }) },
    ],
  };
}

function ok(): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
  };
}

function invalid(message: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * Names the specific changed file that masks `testId`/`testName` — mirrors
 * isTestIdTouchedByChangedFiles's own matching predicate (session/test-runner.ts)
 * so the flaky.confirm refusal can name the file, not just say "touched".
 */
function findTouchedTestFile(
  testId: string,
  testName: string,
  changedFiles: string[],
): string | undefined {
  const classname = classnameFromTestId(testId, testName);
  if (!classname) return undefined;
  const candidatePath = classname.replace(/\./g, '/');
  return changedFiles.find((f) => {
    const noExt = f.replace(/\.[^./]+$/, '');
    return (
      noExt === candidatePath ||
      candidatePath.startsWith(`${noExt}/`) ||
      noExt.endsWith(`/${candidatePath}`)
    );
  });
}

/**
 * Registers the verdict-delivery MCP tool surface — one tool per
 * stdout-scraped disposition block the retired parsers (parseDispositionBlock
 * / parseVerifiedFlakyDisposition / parseGateVerifyDisposition, see
 * AgentSession.ts) used to extract from assistant text. Each tool delegates
 * to the matching AgentSession.recordXDisposition method, which emits the
 * exact same internal event (dispositions_parsed / verified_flaky_disposition
 * / gate_verify_disposition) those parsers emitted, so ReviewOrchestrator,
 * PRMergeWatcher, and GateItemVerifier are unaffected by this new transport.
 * Idempotency (per session, per item) is enforced inside those AgentSession
 * methods — a same-content repeat call is a dedup no-op.
 */
export function registerVerdictTools(
  server: McpServer,
  ctx: VerdictToolContext,
): void {
  if (ctx.workflow === null) {
    server.registerTool(
      'review.disposition',
      {
        title: 'Report a review-thread disposition',
        description:
          'Reports how this session addressed one PR review comment — addressed/wont_fix/out_of_scope. Call once per comment_id; a repeat call with a changed disposition is last-write-wins.',
        inputSchema: {
          comment_id: z.number(),
          disposition: reviewDispositionSchema,
          reason: z.string().optional(),
        },
      },
      async (args) => {
        const session = ctx.getSession();
        if (!session) return notLive();
        session.recordReviewDisposition({
          comment_id: args.comment_id,
          disposition: args.disposition,
          reason: args.reason,
        });
        return ok();
      },
    );

    server.registerTool(
      'flaky.confirm',
      {
        title: 'Confirm a verified-flaky CI/gate failure',
        description:
          'Reports a failing CI/F2/analyze gate as flaky/unrelated to this diff, instead of pushing an empty commit. Call once with what you observed — do not re-run the suite yourself first: the backend adjudicates against its own cross-SHA outcome corpus and refuses if the test does not clear it or if its file is in your diff. For gate "ci"/"f2" pass testId and testName identifying the failing test (as reported by the failing run) — required for those gates. gate "analyze" (the orchestrator-run static-analysis gate) has no per-test id and is not checked against the corpus.',
        inputSchema: {
          gate: flakyGateSchema,
          reason: z.string(),
          testId: z.string().optional(),
          testName: z.string().optional(),
        },
      },
      async (args) => {
        const session = ctx.getSession();
        if (!session) return notLive();

        if (args.gate !== 'analyze') {
          if (!args.testId || !args.testName) {
            return invalid(
              `gate "${args.gate}" requires testId and testName identifying the failing test so the backend can check it against the cross-SHA corpus`,
            );
          }
          const pr = getPRBySessionId(ctx.sessionId);
          if (!pr) return invalid('no open PR for this session');
          const beforeMs = pr.created_at ? Date.parse(pr.created_at) : NaN;
          if (!Number.isFinite(beforeMs)) {
            return invalid(
              'this PR has no recorded creation time to scope the corpus check against',
            );
          }
          const corpus = evaluateTestFlakinessCorpus(
            args.testId,
            beforeMs,
            typedGetSetting('flip_rate_window_n'),
            typedGetSetting('flip_rate_threshold_k'),
            typedGetSetting('flip_rate_breadth_n'),
            typedGetSetting('flip_rate_breadth_window_hours'),
          );
          if (!corpus.eligible) {
            return invalid(`${args.testName} ${corpus.reason}`);
          }

          let changedFiles: string[];
          try {
            changedFiles = await getChangedFiles(
              session.worktreePath,
              pr.base_branch ?? 'dev',
            );
          } catch (err) {
            return invalid(
              `could not resolve this session's changed files: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          const { touched, confident } = isTestIdTouchedByChangedFiles(
            args.testId,
            args.testName,
            changedFiles,
          );
          if (!confident) {
            return invalid(
              `${args.testName} could not be confidently mapped to a source file to check against this session's diff`,
            );
          }
          if (touched) {
            const touchedFile = findTouchedTestFile(
              args.testId,
              args.testName,
              changedFiles,
            );
            return invalid(
              `${touchedFile ?? `${args.testName}'s own file`} is in this session's diff — a session cannot wave through a failure it may have caused`,
            );
          }
        }

        session.recordVerifiedFlakyDisposition({
          gate: args.gate,
          reason: args.reason,
        });
        return ok();
      },
    );
  }

  if (ctx.workflow === 'ops') {
    server.registerTool(
      'gate.verify',
      {
        title: 'Stage a gate-item verification disposition',
        description:
          'Stages this read-only gate-verify session\'s finding for the single gate item it was dispatched to verify — pass/fail/needs-setup/not-yet-triggerable, plus an optional self-correction reclassify proposal (Human-Observation or needs-triage only) — as a normal gate.verify intent for an operator to dispose on the decision surface, exactly like any other staged intent. Use needs-setup only when a real setup step is missing that a human must perform; use not-yet-triggerable when the scenario simply has not occurred yet or the data does not exist yet — it parks the item for a scheduled retry instead of shelving it. gateItemId must be the FULL gate item uuid (e.g. "3b022f91-52f3-8173-b9b2-ada4fdb54c82"), never an 8-character short form — this project\'s ids share long structured prefixes, so a truncated id is rejected at stage time rather than resolved. The operator, never the session or the backend automatically, turns this into the gate_item_event write; a rejection resumes this session for a normal turn to revise and report again, with no limit on revisions.',
        inputSchema: {
          gateItemId: z.string(),
          disposition: gateVerifyDispositionSchema,
          evidence: gateVerifyEvidenceSchema.optional(),
          reclassify: gateVerifyReclassifySchema.optional(),
        },
      },
      async (args) => {
        const session = ctx.getSession();
        if (!session) return notLive();
        const parsed = gateVerifyPayloadSchema.safeParse(args);
        if (!parsed.success) {
          return invalid(parsed.error.issues.map((i) => i.message).join('; '));
        }
        let staged;
        try {
          staged = session.recordGateVerifyDisposition({
            gateItemId: args.gateItemId,
            disposition: args.disposition,
            evidence: args.evidence,
            reclassify: args.reclassify,
          });
        } catch (err) {
          return invalid(err instanceof Error ? err.message : String(err));
        }
        const result: z.infer<typeof gateVerifyResultSchema> = {
          status: 'ok',
          id: staged.id,
          milestone: staged.milestone ?? null,
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.registerTool(
      'deploy.verdict',
      {
        title: 'Report a deploy agentic-step verdict',
        description:
          "Reports this dispatched deploy-agentic-step session's finding — approved/rejected/inconclusive — as your final action. Call exactly once, never as a chat block: the deploy engine gates the next playbook step directly on this report, with no operator disposition in between. The run/step this applies to is resolved from this session's own dispatch, not from any argument you pass — you cannot report for a step other than the one you were dispatched to validate.",
        inputSchema: {
          verdict: deployAgenticVerdictSchema,
          detail: z.string().optional(),
        },
      },
      async (args) => {
        const session = ctx.getSession();
        if (!session) return notLive();
        try {
          session.recordDeployAgenticVerdict({
            verdict: args.verdict,
            detail: args.detail,
          });
        } catch (err) {
          return invalid(err instanceof Error ? err.message : String(err));
        }
        return ok();
      },
    );
  }
}
