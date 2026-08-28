import path from 'path';
import fs from 'fs';
import { execSync, exec as execCb } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const exec = promisify(execCb);

const GIT_CONFIG_LOCK_RE =
  /could not lock config file .*\.git[/\\]config: File exists/;

import { recordEvent } from '../audit/AuditLog';
import type { WorktreeTeardownRefusedPayload } from '../audit/types';
import { scrubSecrets } from '../security/scrubSecrets';
import { AgentSession, isMcpUnreachable } from './AgentSession';
import { deriveTaskId } from '../tasks/deriveTaskId';
import { buildSessionContext } from './ContextBuilder';
import {
  buildReviewClaudeMd,
  buildDepthReviewClaudeMd,
} from './orchestrator-claudemd';
import {
  resolveStartingPoint,
  ensureMilestoneBranch,
  deriveBranchSlug,
  resolveResumeBranchSlug,
  resolveAvailableBranchSlug,
} from './branchModel';
import {
  loadOrchestratorConfig,
  isGrantable,
  isToolShapedCapability,
  resolvePreGrantCapabilities,
} from './orchestrator-config';
import { WorktreeSetupError } from './WorktreeSetupError';
import { CliSessionRunner } from './CliSessionRunner';
import {
  killSessionCgroup,
  reapOrphanedMainCgroupProcesses,
} from './sessionCgroup';
import {
  revokeStageCredential,
  mintStageCredential,
  setRevokedStageCredentialHandler,
} from '../auth/SessionStageAuth';
import {
  revokeRouteCredential,
  writeRouteCredentialFile,
  setRevokedRouteCredentialHandler,
} from '../auth/SessionRouteAuth';
import {
  buildOrchestratorMcpServerEntry,
  ORCHESTRATOR_MCP_SERVER_NAME,
} from '../mcp/orchestratorMcpServer';
import {
  buildNotionMcpServerEntry,
  NOTION_MCP_SERVER_NAME,
} from '../mcp/notionMcpServer';
import { getOrchestratorConfig } from '../config/appConfig';
import { getDataDir } from '../config/dataDir';
import { ApiSessionRunner } from './ApiSessionRunner';
import type { ISessionRunner } from './SessionRunner';
import {
  DockerSessionRunner,
  reapOrphanContainers,
} from './DockerSessionRunner';
import { getCorporateMode } from '../config/corporateMode';
import {
  config,
  getProjectById,
  normalizePath,
  runtimeSettings,
} from '../config';
import {
  insertSession,
  updateSessionStatus,
  recordSessionErroredWriteSkipped,
  recordTaskDemotionSkippedOpenPr,
  updateSessionWorktreePath,
  setSessionFeatureBranch,
  markSessionDone,
  markSessionIdle,
  applyPendingDone,
  getSessionsWithUnappliedPendingDone,
  archiveSession,
  markSessionSuperseded,
  insertEvent,
  getSession,
  getSessionsByStatus,
  getPRByNotionTaskId,
  getTaskCache,
  getEventsBySession,
  getPRByNumber,
  getPRBySessionId,
  getStuckResultSessionRows,
  getRunningSessionsWithMergedOrClosedPR,
  hasActiveSessionForTask,
  hasActivePlanningSessionForTask,
  getOtherRunningSessionsForTask,
  setSessionPauseReason,
  setSessionLastErrorDetail,
  incrementTaskCrashCount,
  setTaskPauseReason,
  getTerminalSessionsForTask,
  listSessionsWithUndeliveredInboxItems,
  listNonTerminalSessionsWithUndeliveredInboxItems,
  listUndeliveredInboxItems,
  markInboxItemsDelivered,
  enqueueFeedbackItem,
  addGrantedCapability,
  removeGrantedCapability,
  getGrantedCapabilities,
  seedGrantedCapabilities,
  setSessionDeclaredWrites,
  setSessionDocsTargetSurface,
  getSessionDocsTargetSurface,
  reapStagedIntentsForNeverStagedSession,
  hasStagedIntentForTask,
  hasUndispositionedStagedIntentsForSession,
  sweepStagedIntentsForTerminalSessions,
  TERMINAL_SESSION_STATUSES,
  listStagedIntentsBySession,
  insertCompletingSignal,
  listCompletingSignalsForSession,
  setSessionTerminalCompletionReason,
  incrementSessionPokeRetryCount,
  resetSessionPokeRetryCount,
  hasMcpConnectionEstablishedSince,
  countMcpUnreachableRespawnAttempts,
  getLatestMcpUnreachableRespawnTimestamp,
  hasMcpUnreachableExhaustedEvent,
  listLiveSessionRows,
  setSessionAwaitingOperatorDecision,
  clearSessionAwaitingOperatorDecision,
  getSessionOperatorQuestion,
} from '../db/queries';
import { recoverSession } from './sessionRecovery';
import {
  isSessionProcessAlive,
  killWorktreeProcessTree,
} from './processLiveness';
import {
  reconcileSessionLiveness,
  reconcileNonPlanningSessionLiveness,
  reconcileOrphanProcesses,
  type SessionLivenessReconcileResult,
  type OrphanProcessReconcileResult,
} from './sessionLivenessReconciler';
import { isUsageAdmitted } from '../orchestration/usageAdmission';
import { CrashBudget } from '../orchestration/crashBudget';
import { tryDependencyCachePool } from '../orchestration/dependencyCachePool';
import {
  countsAgainstConcurrency,
  countsAgainstCodeSessionConcurrency,
  isGateVerifySession,
  isPlanningSession,
  movesTargetInProgress,
  usesWorktree,
  type SessionType,
} from './sessionPredicates';
import { eventKind } from './eventKind';
import type { Session, StagedIntentRow } from '../db/types';
import { deriveSessionStatus } from './sessionStatusDeriver';
import { getTaskBackend } from '../tasks/TaskBackend';
import { STATUS_DISPLAY } from '../tasks/statusCanonical';
import type { GitHubClient } from '../github/GitHubClient';
import type { ServerMessage } from '../ws/types';
import { deriveDisplayStatusFromDb } from '../tasks/TaskStatusEngine';
import type { DisplayStatus } from '../tasks/TaskStatusEngine';
import { emitTaskUpdated } from '../routes/tasks';
import { parseSection } from '../notion/NotionClient';
import type { DeclaredWriteEntry } from '../tasks/readinessGate';
import {
  formatReviewFeedback,
  formatApprovedVerdictMessage,
} from '../github/reviewUtils';
import type { PRReviewResult } from '../github/PRReviewService';
import { logger } from '../logger';

export { deriveTaskId };

/** Max chars per file snippet to avoid bloating the CLAUDE.md. */
const MAX_FILE_CHARS = 8_000;
/** Max total chars for all file snippets combined. */
const MAX_TOTAL_SNIPPET_CHARS = 40_000;

/**
 * Consecutive-failure budget for the sendOrResume/_doSendOrResume live poke
 * path before flagResumeFailure's terminal disposition fires — see
 * session_poke_retry_counts (db/schema.ts) and
 * incrementSessionPokeRetryCount (db/queries.ts). One higher than
 * task_crash_counts's circuit breaker (trips at 2, SessionManager.ts:1329,
 * 1441): a poke/resume failure is more often transient (a stale git
 * worktree registration, a momentary fetch failure) than a full session
 * process crash, so it earns one additional retry.
 */
const POKE_RETRY_LIMIT = 3;

/**
 * MCP-connection grace window for reconcileMcpUnreachableSessions: the
 * CLI's MCP client connects asynchronously after spawn, so a session
 * legitimately shows zero mcp_connection_established events for the first
 * stretch after every spawn/respawn — detection must never fire inside
 * this window. See that method's doc comment for the full failure mode.
 */
const MCP_UNREACHABLE_GRACE_MS = 3 * 60_000;

/**
 * Cap on MCP-unreachable respawn attempts per session — same bounded-retry
 * shape as MAX_VERIFIER_RECLASSIFY_ATTEMPTS (gateService.ts),
 * DEFAULT_MAX_DISPATCH_ATTEMPTS (gateReconciler.ts), and
 * flake_recovery_max_retries (settings.ts). At the cap the session is
 * surfaced to the operator (pause_reason='mcp_unreachable_exhausted') and
 * never respawned again by this path.
 */
const MAX_MCP_UNREACHABLE_RESPAWNS = 2;

/**
 * Parse file paths from the task spec's "Files" section, read each file from
 * the project directory, and return a markdown block with their contents.
 * Returns undefined if no files are found or all reads fail.
 */
function readTaskFiles(
  taskMarkdown: string,
  projectDir: string,
): string | undefined {
  const filesSection = parseSection(taskMarkdown, 'files');
  if (!filesSection.trim()) return undefined;

  const filePaths = filesSection
    .split('\n')
    .map((line) => line.replace(/^[-*\s]+/, '').trim())
    // Strip backticks, trailing descriptions, and markdown formatting like *(new)*
    .map((line) =>
      line
        .replace(/`/g, '') // remove backticks
        .replace(/\s+\*?\(.*?\)\*?\s*$/, '') // remove *(new)*, (update), etc.
        .replace(/\s+[-—–].*$/, '') // remove "— description" suffixes
        .trim(),
    )
    .filter(
      (line) => line.length > 0 && (line.includes('/') || line.includes('.')),
    );

  if (filePaths.length === 0) return undefined;

  const snippets: string[] = [];
  let totalChars = 0;

  for (const filePath of filePaths) {
    if (totalChars >= MAX_TOTAL_SNIPPET_CHARS) break;

    const fullPath = path.join(projectDir, filePath);
    try {
      if (!fs.existsSync(fullPath)) continue;
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;

      let content = fs.readFileSync(fullPath, 'utf-8');
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS) + '\n[... truncated]';
      }

      snippets.push(`### \`${filePath}\`\n\`\`\`\n${content}\n\`\`\``);
      totalChars += content.length;
    } catch {
      // Skip unreadable files silently
    }
  }

  if (snippets.length === 0) return undefined;

  return (
    `## Referenced Files\n\n` +
    `> These are the current contents of files listed in the task spec.\n` +
    `> They were pre-read by the orchestrator so you can skip exploration.\n\n` +
    snippets.join('\n\n')
  );
}

/**
 * Resolves the backend's own port for the orchestrator MCP server URL,
 * falling back to the documented default (see CONFIG_DEFAULTS) if the app
 * config can't be resolved — this runs on every session start/resume, so it
 * must not take the whole spawn down over a transient config read issue.
 */
function resolveBackendPort(): number {
  try {
    return getOrchestratorConfig().server.port;
  } catch {
    return 3000;
  }
}

/**
 * Directory the per-session MCP config file is written under —
 * `<app-data-dir>/session-mcp-configs/`, deliberately outside any project
 * checkout. The notion server entry (when present) carries the resolved
 * Notion API key inlined directly (see
 * mcp/notionMcpServer.ts#buildNotionMcpServerEntry): the installed
 * `@notionhq/notion-mcp-server` only reads its credential from a literal env
 * value, not a `${VAR}` placeholder the CLI would expand, so the real secret
 * has to land in this file's bytes. Siting the file under the project
 * checkout (as previously done, alongside the per-session system-prompt
 * file) would put that secret at a path the dispatched session's own file
 * tools — and anything that inspects the checkout — can read. The app data
 * dir is backend-owned and never part of a project's git tree.
 *
 * `MCP_CONFIG_DIR` overrides the base location (tests use this to redirect
 * writes to a temp dir instead of the real app data dir).
 * Exported for unit testing.
 */
export function mcpConfigDir(): string {
  return path.join(
    process.env.MCP_CONFIG_DIR || getDataDir(),
    'session-mcp-configs',
  );
}

/**
 * Write a per-session MCP config file to
 * `mcpConfigDir()/<sessionId>.mcp.json` and return its absolute path. Always
 * includes the loopback-only orchestrator MCP server entry (authed with this
 * session's stage credential), merged with any per-project mcp_servers —
 * under the CLI's strict-mcp-config flag a session sees exactly the
 * configured servers, so both must be present.
 *
 * Sited by sessionId under the app data dir rather than under projectDir or
 * worktreePath: planning sessions (groom/design/ops) share
 * worktreePath === projectDir, so a worktree-relative path would collide
 * across concurrently dispatched sessions and the last writer's stage
 * credential would win for all of them. Siting it outside any project
 * checkout additionally keeps the inlined Notion API key (see below) off a
 * path the dispatched session — or anything else with checkout access — can
 * read.
 *
 * `taskSource` gates in the Notion read MCP server (mcp/notionMcpServer.ts):
 * only Notion-task-source projects get it registered, matching the
 * NOTION_READ_MCP_TOOLS allow-list gating in
 * orchestrator-config.ts#getSessionAllowedTools — a Jira/GitHub/YAML project
 * gets no notion entry here and no Notion tools in its allow-list.
 *
 * Written with mode 600: the notion server entry (when present) carries the
 * resolved Notion API key inlined directly (see
 * mcp/notionMcpServer.ts#buildNotionMcpServerEntry), and the file already
 * carries the orchestrator stage credential regardless, so it's kept
 * unreadable to other users.
 * Exported for unit testing.
 */
export function writeMcpConfig(
  _projectDir: string,
  sessionId: string,
  mcpServers: Record<string, unknown> | undefined,
  taskSource?: 'notion' | 'yaml' | 'jira' | 'github',
): string {
  const stageToken = mintStageCredential(sessionId);
  // Mint (idempotent) and deliver this session's route-client credential
  // alongside the stage token, at the same spawn/resume call sites — see
  // SessionRouteAuth.ts for what this authorizes. The delivery file path
  // itself is deterministic (routeCredentialFilePath) and threaded to the
  // child via extraEnv in AgentSession.ts; nothing further is needed here
  // beyond ensuring the file is (re)written before spawn.
  writeRouteCredentialFile(sessionId);
  const port = resolveBackendPort();
  const merged = {
    ...mcpServers,
    ...(taskSource === 'notion'
      ? {
          [NOTION_MCP_SERVER_NAME]: buildNotionMcpServerEntry(
            config.notionApiKey,
          ),
        }
      : {}),
    [ORCHESTRATOR_MCP_SERVER_NAME]: buildOrchestratorMcpServerEntry(
      port,
      stageToken,
    ),
  };
  const dir = mcpConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.mcp.json`);
  fs.writeFileSync(filePath, JSON.stringify({ mcpServers: merged }, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return filePath;
}

/**
 * Write the assembled orchestrator session rules + task spec to a per-session
 * file that lives OUTSIDE the managed worktree, at
 * `<projectDir>/.claude/session-prompts/<sessionId>.md`.
 *
 * The path is returned so it can be passed via --append-system-prompt-file.
 * Exported for unit testing.
 */
export function writeSystemPromptFile(
  projectDir: string,
  sessionId: string,
  content: string,
): string {
  const dir = path.join(projectDir, '.claude', 'session-prompts');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Context-occupancy fraction above which a resumed non-large session is proactively
 * escalated to large_task_model in _doSendOrResume rather than waiting for an
 * overflow event that may never fire (e.g. when the CLI is alive-but-inert at ceiling).
 */
export const PROACTIVE_ESCALATION_HWM = 0.9;

/**
 * Returns true when the session's persisted context occupancy is at/over the
 * proactive-escalation high-water mark AND escalation is possible (large_task_model
 * is configured and the session is not already on it).
 * Exported for unit testing.
 */
export function isSessionAtContextCeiling(row: {
  model?: string | null;
  context_occupancy_tokens?: number;
}): boolean {
  const largeModel = runtimeSettings.large_task_model;
  if (!largeModel) return false;
  if (row.model && row.model === largeModel) return false;
  const tokens = row.context_occupancy_tokens ?? 0;
  if (!tokens) return false;
  const windowSize = AgentSession.contextWindowForModel(row.model ?? null);
  return tokens / windowSize >= PROACTIVE_ESCALATION_HWM;
}

/**
 * Builds the escalation nudge message that is delivered to the large-model session
 * after a proactive ceiling-escalation. Mirrors the text from tryEscalateForOverflow.
 */
function buildProactiveEscalationNudge(pendingText: string): string {
  return (
    `Your previous session reached the context ceiling and has been resumed on a 1M-context model. ` +
    `The following message was pending delivery — please process it now:\n\n${pendingText}`
  );
}

export interface StartOptions {
  taskType?: string;
  sessionType?:
    | 'standard'
    | 'review'
    | 'groom'
    | 'design'
    | 'ops'
    | 'split'
    | 'docs'
    | 'depth_review';
  customPrompt?: string;
  projectId?: string;
  taskName?: string;
  /** Pre-generated session ID. If omitted, a new UUID is generated internally. */
  sessionId?: string;
  /** Milestone row id used for starting-point resolution in two_tier branch mode. */
  milestoneId?: string | null;
  /** Whether this is a milestone task or a non-milestone task; recorded in the audit log. */
  taskKind?: 'milestone' | 'non_milestone';
  /**
   * Pre-computed task ID in `source:externalId` format (e.g. `github:123`, `notion:<uuid>`).
   * When provided, bypasses URL-based task ID derivation so callers with an already-formatted
   * ID (AutoLauncher, PRReviewService) don't double-parse via Notion-specific logic.
   */
  taskId?: string;
  /**
   * Resolved GitHub repo (owner/repo) for this session. Determined at launch time from
   * task_repo_assignments for multi-repo projects, or auto-resolved for single-repo projects.
   * Used for branch deletion and other GitHub API calls in completeStart.
   */
  repo?: string;
  /**
   * Backend-injected ops context for an Ops(N)-launched session (loadOpsContext
   * output + the task's ops_journal entry, rendered as markdown). Appended to
   * the pre-fetched task content, same as file snippets — the session never
   * runs the vendored /ops skill to assemble this itself.
   */
  opsContext?: string;
  /**
   * Pre-assembled injected planning-procedure content (`planning/
   * procedureAssembler.ts`'s `assemblePlanningProcedure` output) for a groom/
   * design session dispatched via /api/planning/launch. When present for a
   * planning session, this content is delivered as the appended-prompt file
   * verbatim — buildOrchestratorClaudeMd/buildSessionContext are skipped
   * entirely, since the assembler already carries the session-lifecycle and
   * transport rules those builders would otherwise inject.
   */
  injectedProcedureContent?: string;
  /**
   * Per-launch model/effort override (e.g. from the Ops(N)/Groom(N)/Design(N)
   * launch picker). Takes precedence over runtimeSettings.*_session_model/
   * _effort when set to a non-empty value; falls back to those settings when
   * unset, same as before this option existed.
   */
  model?: string;
  effort?: string;
  /**
   * Write capabilities the dispatched task declared (and got approved for)
   * at grooming/Ready time — see readinessGate.ts's DeclaredWriteEntry /
   * extractDeclaredWrites and opsLoad.ts's OpsTaskEntry.declaredWrites.
   * Captured once onto the session's durable row (sessions.metadata) at
   * spawn time only (see `start()` below) — never re-read live during the
   * session's run, so a mid-session task-body edit can't retroactively
   * widen an already-dispatched session's auto-approve eligibility. Ops
   * sessions only; every other sessionType ignores it.
   */
  declaredWrites?: DeclaredWriteEntry[];
  /**
   * A dispatched Docs session's declared Target surface (see
   * docs/targetSurface.ts), resolved by OpsSessionLauncher.buildInjectedProcedure
   * before calling start(). Feeds usesWorktree's Target-surface-aware branch
   * so a repo-file Target surface gets a real worktree + branch, same as an
   * ops session, instead of always running stage-only against the project
   * checkout. Ignored for every sessionType other than 'docs'.
   */
  docsTargetSurface?: string;
}

/** How long to suppress lastMessage-only task_updated broadcasts per task (ms). */
const LAST_MESSAGE_THROTTLE_MS = 3_000;

const TERMINAL_STATUSES = new Set([...TERMINAL_SESSION_STATUSES, 'superseded']);
const ALWAYS_GUARDED_BRANCHES = new Set(['dev', 'main']);

/**
 * True only when `worktreePath` is a real per-session worktree — strictly
 * nested under `<projectDir>/.claude/worktrees/` — and never the project
 * checkout itself. Planning sessions (groom/design/ops) run with
 * worktreePath === projectDir and must never be torn down as if they were
 * disposable worktrees (2026-07-20 incident: this deleted a production
 * checkout). Exported for unit testing.
 */
export function isRemovableWorktree(
  worktreePath: string,
  projectDir: string,
): boolean {
  const resolvedWorktree = path.resolve(worktreePath);
  const resolvedProjectDir = path.resolve(projectDir);
  if (resolvedWorktree === resolvedProjectDir) return false;
  const worktreesRoot =
    path.join(resolvedProjectDir, '.claude', 'worktrees') + path.sep;
  return (resolvedWorktree + path.sep).startsWith(worktreesRoot);
}

export interface WorktreeTeardownRefusalClassification {
  expected: boolean;
  reason?: string;
}

/**
 * Classifies an isRemovableWorktree refusal as `expected` (a planning-type
 * session that legitimately owns no per-session worktree — worktreePath is
 * absent or === projectDir, e.g. groom/design/split/undeclared-docs) or
 * `anomalous` (a session type that usesWorktree presenting a path that
 * still isn't removable — the 2026-07-20 incident shape). Reporting-only:
 * the refusal itself (no teardown of a path failing isRemovableWorktree) is
 * identical either way — see the two call sites in cleanupPartialWorktree
 * and cleanupWorktree.
 *
 * `docsTargetSurface` must be passed for 'docs' sessions — usesWorktree's
 * worktree-eligibility for 'docs' depends on the declared Target surface,
 * not sessionType alone (see sessionPredicates.ts). Omitting it for a
 * worktree-eligible 'docs' session misclassifies an anomalous refusal as
 * expected, silencing the exact incident shape this exists to catch —
 * callers must thread it through from setSessionDocsTargetSurface /
 * getSessionDocsTargetSurface rather than defaulting it away.
 */
export function classifyWorktreeTeardownRefusal(
  sessionType: string,
  worktreePath: string,
  projectDir: string,
  docsTargetSurface?: string,
): WorktreeTeardownRefusalClassification {
  if (
    isPlanningSession(sessionType) &&
    !usesWorktree(sessionType, docsTargetSurface)
  ) {
    return { expected: true };
  }
  return {
    expected: false,
    reason: `session type ${sessionType} was expected to own a worktree; path ${worktreePath} is not removable under ${projectDir}`,
  };
}

/**
 * Error causes that are operator-intentional or infra-level and should NOT
 * count against the crash budget. All other causes increment the per-task
 * consecutive crash counter; reaching 2+ consecutive counted failures → 🚫
 * Blocked (circuit breaker).
 *
 * launch_failed is excluded because it reflects pre-spawn infrastructure
 * problems (git fetch / worktree add / bootstrap), not in-session crashes.
 * AutoLauncher owns backoff + escalation for these via session_launch_failed
 * messages.
 */
const UNCOUNTED_REASONS = new Set([
  'user_kill',
  'pr_closed',
  'launch_failed',
  // Kept as a literal (not a reference to BACKEND_SPAWN_DEGRADED_REASON,
  // defined further below) to avoid a temporal-dead-zone load-order issue —
  // this Set is constructed at module init, before that const exists.
  'backend_spawn_degraded',
]);

/** Statuses a dying standard session must never demote from. */
const TERMINAL_TASK_STATUSES = new Set<string>([
  STATUS_DISPLAY.Done,
  STATUS_DISPLAY.Deferred,
]);

/**
 * Whether a Notion task's current cached status is terminal (Done/Deferred),
 * read via the same task_cache the board caches use — no network round-trip.
 * A cache miss or unparseable payload returns false so the caller falls back
 * to the pre-existing revert behaviour rather than silently skipping it.
 */
function isTaskStatusTerminal(notionTaskId: string): boolean {
  const cacheRow = getTaskCache(notionTaskId);
  if (!cacheRow) return false;
  try {
    const task = JSON.parse(cacheRow.raw_json) as { status?: string };
    return !!task.status && TERMINAL_TASK_STATUSES.has(task.status);
  } catch {
    return false;
  }
}

/**
 * Delete the local session/<sessionId> branch if it exists and conditions are met:
 * session row is terminal (done/error/killed) AND (no pr_url OR PR is merged/closed).
 * Dev/main are always guarded. Missing branch is a silent no-op.
 * Exported for backfill tests.
 */
export function pruneSessionBranch(
  sessionId: string,
  projectDir: string,
): void {
  const branchName = `session/${sessionId}`;

  // Safety guard: never delete dev or main (defense-in-depth)
  if (
    ALWAYS_GUARDED_BRANCHES.has(branchName) ||
    ALWAYS_GUARDED_BRANCHES.has(sessionId)
  )
    return;

  // Silent no-op if the branch doesn't exist
  try {
    execSync(`git rev-parse --verify "${branchName}"`, {
      cwd: projectDir,
      stdio: 'pipe',
    });
  } catch {
    return;
  }

  // Gate: session row must be in a terminal status
  const row = getSession(sessionId);
  if (!row || !TERMINAL_STATUSES.has(row.status)) return;

  // Gate: no pr_url → safe to delete; pr_url → only delete when PR is merged/closed
  if (row.pr_url) {
    const prRow = getPRBySessionId(sessionId);
    if (!prRow || prRow.state === 'open') return;
  }

  try {
    execSync(`git branch -D "${branchName}"`, { cwd: projectDir });
    logger.info(
      `[SessionManager] pruned ${branchName} (session ${sessionId.slice(0, 8)})`,
    );
  } catch (err) {
    logger.error(`[SessionManager] failed to prune ${branchName}: ${err}`);
  }
}

/**
 * Continuation nudge sent to a resumed session after its first CLI event.
 * Exported so tests can verify the exact message without hardcoding it.
 */
export const RESUME_NUDGE_MESSAGE =
  'Continue implementing the task. Check git status and your todo list to see where you left off.';

/**
 * Continuation nudge for a resumed planning/ops session (groom/design/ops/split)
 * with no specific disposition feedback to relay — e.g. resumed before any of
 * its staged intents were dispositioned. Never instructs it to check git status
 * or continue implementing: these sessions are stage-only/read-only and never
 * open a PR.
 */
export const PLANNING_RESUME_FALLBACK_MESSAGE =
  'Re-read the disposition feedback on your staged intents and revise your proposal accordingly.';

/**
 * Continuation nudge for a planning/ops session resumed by the boot-orphan
 * path (a backend restart landed mid-turn) that has no reject-state staged
 * intent to relay. Must state the true cause — a restart, not a disposition
 * — and must not mention disposition feedback or staged intents: neither
 * exists for this session, and PLANNING_RESUME_FALLBACK_MESSAGE's false
 * claim that they do is exactly the bug this message exists to avoid (see
 * buildPlanningResumeMessage).
 */
export const PLANNING_RESTART_RESUME_MESSAGE =
  'Your backend process was restarted, interrupting this session mid-turn. Nothing was decided or rejected while you were gone — continue the work you were doing.';

/** Cap on how many expired intents are individually listed in a single expiry notice — see formatExpiredIntentsFeedback. */
const MAX_EXPIRED_INTENTS_LISTED = 10;

/**
 * Feedback delivered to a session's inbox when one or more of its staged
 * intents were expired (superseded) by markSessionErrored rather than
 * committed, rejected, or superseded through the normal disposition/verify
 * flow. Mirrors formatStageTimeBlockFeedback's role for stage-time blocks:
 * a plain statement of what happened plus the concrete next step, rather than
 * a second message dialect. Bounded to MAX_EXPIRED_INTENTS_LISTED individual
 * entries so a session with many staged intents gets a summary, not a dump.
 */
function formatExpiredIntentsFeedback(
  expired: Array<Pick<StagedIntentRow, 'id' | 'kind' | 'group_id'>>,
): string {
  const shown = expired.slice(0, MAX_EXPIRED_INTENTS_LISTED);
  const lines = shown.map((intent) => {
    const groupSuffix = intent.group_id ? ` (group ${intent.group_id})` : '';
    return `- ${intent.id} (${intent.kind})${groupSuffix}`;
  });
  const overflow = expired.length - shown.length;
  const overflowLine =
    overflow > 0 ? `\n...and ${overflow} more expired intent(s)` : '';
  const plural = expired.length === 1 ? 'intent was' : 'intents were';
  return (
    `${expired.length} staged ${plural} expired while you were gone and are no ` +
    `longer on the decision surface:\n` +
    lines.join('\n') +
    overflowLine +
    `\nThey were not committed and will not be revived automatically — re-stage ` +
    `any of them deliberately if the work is still wanted.`
  );
}

/**
 * True when the session has at least one staged_intent row expired with a
 * disposition_reason starting "session_" — the shape left behind by a
 * direct expireStagedIntentsForSession call (e.g. a manual/ops disposition,
 * or historical rows from before status-keyed auto-reaping was removed).
 * markSessionErrored's own automatic reap no longer produces rows like this
 * for a session with real staged-intent history — see
 * reapStagedIntentsForNeverStagedSession. Used by buildPlanningResumeMessage
 * to avoid pairing a restart-resume with the false "nothing was decided or
 * rejected" claim when something in fact was expired. Deliberately does not
 * distinguish delivered-vs-undelivered — even after the expiry notice has
 * been delivered, PLANNING_RESTART_RESUME_MESSAGE's claim about *this*
 * session's history remains false.
 */
function hasExpiredStagedIntents(sessionId: string): boolean {
  return listStagedIntentsBySession(sessionId).some(
    (intent) =>
      intent.state === 'superseded' &&
      (intent.disposition_reason ?? '').startsWith('session_'),
  );
}

/**
 * Why a session is being resumed — threaded from the call site rather than
 * inferred from state, so buildResumeMessage never has to guess. 'restart'
 * is the boot-orphan path (resumeSession's only caller): every 'running'
 * session left behind by a backend restart. 'disposition' is the
 * enqueueFeedback → deliverUndeliveredInboxItems → sendOrResume path, which
 * delivers the inbox item directly and does not call buildResumeMessage —
 * kept here only so a future caller on that path fails loudly if it forgets
 * to pass a cause, rather than silently defaulting to 'restart'.
 */
export type ResumeCause = 'restart' | 'disposition';

/**
 * Human-facing label for a staged intent in a resume nudge, e.g.
 * `task.create "Fix the thing"` or `task.setStatus for task-123`. Falls back
 * to the bare kind when the payload carries neither a title nor a taskId —
 * every staged intent kind has a `kind`, so this never returns an empty label.
 */
function describeStagedIntentForNudge(intent: {
  kind: string;
  payload: string;
}): string {
  let title: string | undefined;
  let taskId: string | undefined;
  try {
    const payload = JSON.parse(intent.payload) as Record<string, unknown>;
    if (typeof payload.title === 'string') title = payload.title;
    if (typeof payload.taskId === 'string') taskId = payload.taskId;
  } catch {
    // Malformed payload — fall through to the bare kind label.
  }
  if (title) return `${intent.kind} "${title}"`;
  if (taskId) return `${intent.kind} for ${taskId}`;
  return intent.kind;
}

/**
 * Build the resume nudge for a planning/ops session: name the most recently
 * updated staged intent that landed in a reject state and branch the message
 * on which reject state it's in. `rejected` means the operator declined the
 * intent outright — terminal, so the message must not instruct the session
 * to revise, re-stage, supersede, or withdraw it. `needs_revision` means
 * pushback — revisable, so the message instructs the session to revise it
 * (see transitionRejectedIntent in stagedIntents.ts for the state contract).
 * Falls back to PLANNING_RESTART_RESUME_MESSAGE (for a restart-caused resume)
 * or PLANNING_RESUME_FALLBACK_MESSAGE (for any other cause) when neither
 * state is present, rather than a generic instruction it can misinterpret as
 * "nothing to do here" (see PLANNING_RESUME_FALLBACK_MESSAGE doc-comment for
 * why silence is not an acceptable fallback). When a reject-state intent
 * *does* exist on a restart-caused resume, that feedback wins — it is the
 * more specific and more actionable of the two true facts — so the restart
 * message is only ever the fallback, never layered on top. Exported so
 * tests can verify the exact message without hardcoding it.
 */
export function buildPlanningResumeMessage(
  row: Session,
  cause: ResumeCause = 'disposition',
): string {
  const intents = listStagedIntentsBySession(row.session_id);
  let mostRecentReject: (typeof intents)[number] | undefined;
  for (const intent of intents) {
    if (intent.state !== 'rejected' && intent.state !== 'needs_revision') {
      continue;
    }
    if (!mostRecentReject || intent.updated_at >= mostRecentReject.updated_at) {
      mostRecentReject = intent;
    }
  }
  if (!mostRecentReject) {
    // PLANNING_RESTART_RESUME_MESSAGE asserts nothing was decided or
    // rejected while the session was gone — false whenever intents were
    // expired (see hasExpiredStagedIntents). The expiry notice itself is
    // delivered separately via the inbox (see markSessionErrored); this
    // just avoids pairing it with a contradicting reassurance.
    if (cause === 'restart' && hasExpiredStagedIntents(row.session_id)) {
      return PLANNING_RESUME_FALLBACK_MESSAGE;
    }
    return cause === 'restart'
      ? PLANNING_RESTART_RESUME_MESSAGE
      : PLANNING_RESUME_FALLBACK_MESSAGE;
  }

  const label = describeStagedIntentForNudge(mostRecentReject);
  const reason =
    mostRecentReject.disposition_reason?.trim() || 'no reason given';

  if (mostRecentReject.state === 'rejected') {
    return `Your staged intent ${label} was declined: ${reason}. This decision is final; move on to other work.`;
  }
  return `Your staged intent ${label} was sent back: ${reason}. Re-read this feedback and revise your staged intent accordingly.`;
}

/**
 * Build the resume nudge message for a session row, branched on session
 * type. A planning/ops session (groom/design/ops/split) never writes code or
 * opens a PR, so it must never receive RESUME_NUDGE_MESSAGE — it gets the
 * reason it was resumed instead (see buildPlanningResumeMessage).
 *
 * For a code session, when its PR has a stored review verdict, inject that
 * verdict so the coder doesn't need to query GitHub (where verdicts are
 * never posted). Falls back to the plain RESUME_NUDGE_MESSAGE when there is
 * no verdict or the stored JSON is malformed. `cause` defaults to
 * 'disposition' since resumeSession's boot-orphan caller is the only
 * production caller that has a definite cause ('restart') to pass; see
 * ResumeCause's doc-comment. Exported so tests can verify the exact message
 * without hardcoding it.
 */
export function buildResumeMessage(
  row: Session,
  cause: ResumeCause = 'disposition',
): string {
  if (isPlanningSession(row.session_type)) {
    return buildPlanningResumeMessage(row, cause);
  }
  const pr = getPRBySessionId(row.session_id);
  if (!pr?.review_result) return RESUME_NUDGE_MESSAGE;
  try {
    const result = JSON.parse(pr.review_result) as PRReviewResult;
    if (result.verdict === 'needs_changes' || result.verdict === 'incomplete') {
      return formatReviewFeedback(result, pr.review_iteration ?? 0, {
        conflicted: pr.merge_state === 'dirty',
        baseBranch: pr.base_branch ?? undefined,
      });
    }
    if (result.verdict === 'approved') {
      return formatApprovedVerdictMessage(result);
    }
  } catch {
    // Malformed review_result — fall through to plain nudge.
  }
  return RESUME_NUDGE_MESSAGE;
}

/**
 * Per-repo mutex for `git worktree add`. Every worktree add for a given repo
 * touches the same `.git/config` (git worktree registers/unregisters entries
 * there), so concurrent launches against the *same* repo must run one at a
 * time. Launches against different repos share no state and must not be
 * serialized against each other — the queue is keyed by resolved repo path,
 * not global, so it cannot become an effective concurrency cap when many
 * sessions across different projects start together.
 *
 * Chains a promise per key rather than using a counting semaphore: each new
 * caller attaches its work to the tail of the current chain for that repo,
 * so callers naturally run in arrival order and the map entry self-cleans
 * once the chain is idle.
 */
const repoWorktreeLocks = new Map<string, Promise<void>>();

async function withRepoWorktreeLock<T>(
  repoDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(repoDir);
  const tail = repoWorktreeLocks.get(key) ?? Promise.resolve();
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = tail.then(() => gate);
  repoWorktreeLocks.set(key, chained);
  await tail;
  try {
    return await fn();
  } finally {
    release!();
    if (repoWorktreeLocks.get(key) === chained) {
      repoWorktreeLocks.delete(key);
    }
  }
}

/**
 * Outcome of a pre-launch base-branch fetch: `ok: false` means the fetch
 * failed (or lost the ref lock to a concurrent fetch outside this process)
 * and the caller is proceeding against whatever the local ref already holds.
 * `benignRefLock: true` narrows that further: the failure was a lost
 * `refs/remotes/origin/<base>` ref-lock race (another fetch against the same
 * object store — a worktree, an audit/base-health check, a deploy — won the
 * lock first) *and* the ref now holds the exact value this fetch wanted to
 * write. The remote state the caller wanted is present; this was a no-op
 * failure, not a stale base.
 */
export interface BaseFetchOutcome {
  ok: boolean;
  error?: unknown;
  benignRefLock?: boolean;
}

/**
 * relaunchFixerForPR's typed failure for a PR whose session_id no longer
 * resolves to a sessions row — distinguishable from the plain-null
 * idle-with-no-worktree/no-session-id outcomes. See relaunchFixerForPR's
 * doc comment.
 */
export interface FixerRelaunchFailure {
  outcome: 'session_row_missing';
}

/** Matches git's ref-lock contention error text across git versions loosely enough to detect the failure mode without depending on exact wording. */
const GIT_REF_LOCK_RE = /cannot lock ref|unable to update local ref/i;

function extractErrorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const message = (error as Error).message;
    const stderr = (error as { stderr?: unknown }).stderr;
    return [message, stderr].filter(Boolean).join('\n');
  }
  return String(error);
}

/**
 * After a failed fetch whose error text indicates a lost ref-lock race,
 * re-read `refs/remotes/origin/<baseBranch>` and compare it against
 * `FETCH_HEAD` (which git updates to the fetched tip regardless of whether
 * the local ref update itself succeeded). Equal, non-empty values mean the
 * winner of the race wrote the same value this fetch wanted — the outcome is
 * benign. Never retries the fetch itself; this only classifies the failure
 * already reported.
 */
async function isBenignRefLockLoss(
  error: unknown,
  projectDir: string,
  baseBranch: string,
): Promise<boolean> {
  if (!GIT_REF_LOCK_RE.test(extractErrorText(error))) {
    return false;
  }
  try {
    const [{ stdout: refOut }, { stdout: fetchHeadOut }] = await Promise.all([
      exec(`git rev-parse refs/remotes/origin/${baseBranch}`, {
        cwd: projectDir,
        timeout: 10_000,
      }),
      exec('git rev-parse FETCH_HEAD', { cwd: projectDir, timeout: 10_000 }),
    ]);
    const ref = refOut.trim();
    const fetchHead = fetchHeadOut.trim();
    return ref.length > 0 && ref === fetchHead;
  } catch {
    return false;
  }
}

/**
 * Per-project state for the pre-launch `git fetch origin <base>` into the
 * shared checkout. Every launch for a project fetches into the same
 * `projectDir` (worktrees are created from it, but the fetch itself runs
 * against the shared `.git`), so unserialized concurrent fetches contend for
 * the same `refs/remotes/origin/<base>` ref and git's own ref lock correctly
 * rejects the loser. `inFlight` serializes: a caller that arrives while a
 * fetch is running reuses that fetch's outcome instead of starting a second
 * one. `completedAt`/`lastOutcome` additionally coalesce: a caller that
 * arrives shortly after a fetch *finished* also reuses its outcome, so a
 * burst of launches in one tick issues one fetch, not N.
 */
interface BaseFetchState {
  inFlight: Promise<BaseFetchOutcome> | null;
  completedAt: number | null;
  lastOutcome: BaseFetchOutcome | null;
}

const baseFetchStates = new Map<string, BaseFetchState>();

/** Reuse a fetch outcome from within this window of the fetch completing. */
const BASE_FETCH_COALESCE_WINDOW_MS = 5_000;

/**
 * Serialized, coalesced `git fetch origin <baseBranch>` for the shared
 * project checkout at `projectDir`. Keyed by resolved project path, not
 * global, so fetches for different projects still run concurrently. Never
 * retries past a git ref-lock failure and never forces the fetch — a failure
 * is reported via the returned outcome for the caller to log/record, not
 * masked or fought past.
 */
export async function fetchBaseBranchCoalesced(
  projectDir: string,
  baseBranch: string,
): Promise<BaseFetchOutcome> {
  const key = path.resolve(projectDir);
  let state = baseFetchStates.get(key);
  if (!state) {
    state = { inFlight: null, completedAt: null, lastOutcome: null };
    baseFetchStates.set(key, state);
  }

  if (state.inFlight) {
    return state.inFlight;
  }

  if (
    state.completedAt !== null &&
    state.lastOutcome !== null &&
    Date.now() - state.completedAt < BASE_FETCH_COALESCE_WINDOW_MS
  ) {
    return state.lastOutcome;
  }

  const promise = (async (): Promise<BaseFetchOutcome> => {
    try {
      await exec(`git fetch origin ${baseBranch}`, {
        cwd: projectDir,
        timeout: 30_000,
      });
      return { ok: true };
    } catch (error) {
      const benignRefLock = await isBenignRefLockLoss(
        error,
        projectDir,
        baseBranch,
      );
      return { ok: false, error, benignRefLock };
    }
  })();

  state.inFlight = promise;
  const outcome = await promise;
  state.inFlight = null;
  state.completedAt = Date.now();
  state.lastOutcome = outcome;
  return outcome;
}

/**
 * A `child_process.exec()` failure with empty stderr and a killed/signal
 * outcome is not a real git/command failure — the child never ran far enough
 * to write diagnostic output. This is the signature of a degraded spawn
 * subsystem on a long-lived backend process (confirmed root cause: an OS
 * suspend/resume on a laptop-hosted backend leaves child_process spawns
 * broken until the backend is restarted). Distinguishing it lets callers
 * surface "the backend may need a restart" instead of investigating a
 * command that never actually ran.
 */
export function isDegradedSpawnFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    stderr?: string | Buffer;
    killed?: boolean;
    signal?: string | null;
  };
  const stderr = e.stderr ? e.stderr.toString() : '';
  return stderr.trim() === '' && (e.killed === true || !!e.signal);
}

/** Reason code used for markSessionErrored/pause-reason when a worktree-add
 * failure is classified as a degraded backend spawn rather than a real
 * per-command failure. Deliberately excluded from crash-budget accounting
 * (see UNCOUNTED_REASONS) — this is a backend-health statement, not a
 * session-level or task-level failure. */
export const BACKEND_SPAWN_DEGRADED_REASON = 'backend_spawn_degraded';

/** Operator-readable explanation surfaced alongside BACKEND_SPAWN_DEGRADED_REASON. */
const BACKEND_SPAWN_DEGRADED_MESSAGE =
  'Backend spawn health check failed: a child process command returned no ' +
  'stderr output and a killed/signal outcome. This is the signature of a ' +
  'degraded spawn subsystem (commonly following an OS suspend/resume on a ' +
  'long-running backend) rather than a real command failure. Restarting the ' +
  'backend process typically resolves this.';

/**
 * Wraps `git worktree add` with a retry loop that fires **only** on transient
 * .git/config lock contention (the "could not lock config file" error). All
 * other errors propagate immediately so the caller's existing branch-already-exists
 * / directory-exists handling is unaffected.
 *
 * The lock is typically held for milliseconds; a short jittered backoff is more
 * than enough to clear it across concurrent session launches. In addition to
 * the retry, every call is serialized per-repo (see withRepoWorktreeLock) so
 * concurrent launches against the same repo queue instead of racing — the
 * lock-contention retry above is a backstop for contention from *outside*
 * this process (e.g. a manual `git worktree add`), not the primary
 * concurrency control.
 */
export async function gitWorktreeAddWithRetry(
  cmd: string,
  opts: { cwd: string; timeout?: number },
  maxAttempts = 3,
  /** Overrideable for unit tests; defaults to 100–300 ms jitter. */
  getDelayMs: () => number = () => 100 + Math.random() * 200,
): Promise<void> {
  return withRepoWorktreeLock(opts.cwd, async () => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await exec(cmd, opts);
        return;
      } catch (err) {
        const stderr =
          (err as { stderr?: string | Buffer })?.stderr?.toString() ?? '';
        if (!GIT_CONFIG_LOCK_RE.test(stderr)) {
          throw err; // non-lock error: fail immediately, no retry
        }
        lastErr = err;
        if (attempt < maxAttempts) {
          const backoffMs = getDelayMs();
          logger.warn(
            `[SessionManager] git worktree add .git/config lock contention (attempt ${attempt}/${maxAttempts}), retry in ${Math.round(backoffMs)}ms: ${stderr.trim()}`,
          );
          if (backoffMs > 0) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, backoffMs),
            );
          }
        }
      }
    }
    throw lastErr;
  });
}

/**
 * Builds a WorktreeSetupError from a `git worktree add` failure, classifying
 * it as a degraded backend spawn when applicable (see isDegradedSpawnFailure)
 * so callers surface a restart recommendation instead of a plain command
 * failure. `fullMsg` should already include the captured stderr — that
 * capture is preserved verbatim; the degraded-spawn explanation is prefixed
 * onto it, never replacing it.
 */
function buildWorktreeSetupError(
  err: unknown,
  fullMsg: string,
  isBranchAlreadyExists: boolean,
): WorktreeSetupError {
  const isDegradedSpawn = isDegradedSpawnFailure(err);
  return new WorktreeSetupError(
    isDegradedSpawn ? `${BACKEND_SPAWN_DEGRADED_MESSAGE}\n${fullMsg}` : fullMsg,
    { isBranchAlreadyExists, isDegradedSpawn },
  );
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  private pendingStarts = new Map<
    string,
    {
      sessionType:
        | 'standard'
        | 'review'
        | 'groom'
        | 'design'
        | 'ops'
        | 'split'
        | 'docs'
        | 'depth_review';
    }
  >();
  /** Concurrency guard: prevents double-spawning when two concurrent sendOrResume calls race. */
  private resumesInFlight = new Map<string, Promise<string | null>>();

  /**
   * Set by respawnSession immediately before it returns null, so a
   * synchronous caller (no await in between) can report the actual
   * admission gate that declined instead of a one-size-fits-all message.
   * Cleared on every respawnSession call so a stale value from a prior call
   * can never leak into an unrelated decision. Safe under concurrent
   * sendOrResume calls because nothing awaits between the respawnSession()
   * call and the read of this field.
   */
  private lastRespawnDeferral: {
    reason: 'usage_limit_deferred';
    detail: string;
  } | null = null;

  /**
   * Late-bound hook to PlanningOrchestrator.tryTerminalizeIfComplete — unset
   * until server.ts wires it via setPlanningTerminalChecker, since
   * PlanningOrchestrator's constructor takes this SessionManager instance
   * and so cannot be constructed first. Consulted by
   * reconcilePlanningSessionLiveness (see sessionLivenessReconciler.ts's
   * tryMarkPlanningTerminal dep) before that sweep would otherwise reap a
   * dead-process planning session as a bare 'killed' with no completion
   * reason recorded.
   */
  private planningTerminalChecker: ((sessionId: string) => boolean) | null =
    null;

  /** Last known DisplayStatus per taskId — used to skip no-op broadcasts. */
  private _lastDisplayStatus = new Map<string, DisplayStatus>();
  /** Timestamp of last lastMessage-only task_updated per taskId. */
  private _lastMessageThrottle = new Map<string, number>();
  /** Guards against re-entrant task_updated emission inside the emit override. */
  private _inTaskUpdate = false;
  /** Session IDs whose local branch should be deleted on worktree cleanup (merged PRs). */
  private _mergedSessionIds = new Set<string>();
  /**
   * Per-session escalating-backoff budget for mid-session (still-running)
   * 529/500 transient API errors. Keyed by sessionId so it survives across
   * the kill+respawn cycle a retry performs (a fresh AgentSession instance
   * would otherwise reset an in-instance counter to zero every attempt).
   */
  private readonly inSessionOverloadBudget = new CrashBudget({
    backoffScheduleMs: [10_000, 30_000, 60_000, 120_000, 300_000],
    escalateAfter: 6,
  });

  constructor(private readonly githubClient?: GitHubClient) {
    super();
    // Turn-boundary drain for a done-transition markSessionDone deferred
    // while this session's turn was in flight (e.g. PRMergeWatcher's
    // markSessionDone racing a still-running review session — see
    // db/queries.ts's in-flight guard). The result event fires the instant
    // the turn's result is processed, whether the session then parks alive
    // (the normal resting state — status stays 'running' with no process
    // exit) or exits; this is the primary drain, mirroring
    // PlanningOrchestrator's pendingApproveTerminal handling of the same
    // signal. applyPendingDoneForSettledSession's run()-settle callers and
    // resumeOrphanSessions' boot sweep remain as backstops for the exit and
    // restart cases this handler can't observe.
    this.on('message', (msg: ServerMessage) => {
      if (msg.type === 'session_event' && msg.eventType === 'result') {
        this.applyPendingDoneOnTurnBoundary(msg.sessionId);
      }
    });

    // A still-live OS process presenting a credential this backend already
    // revoked has no path to recover — it can never obtain a new one (see
    // terminateSessionForRevokedCredential) — so leaving it running only
    // buys it an infinite retry/backoff loop against a server that will
    // never accept it again. Terminate it outright the moment that's
    // detected, rather than relying on the process to infer it from a
    // generic connection failure.
    setRevokedStageCredentialHandler((sessionId) =>
      this.terminateSessionForRevokedCredential(sessionId, 'mcp'),
    );
    setRevokedRouteCredentialHandler((sessionId) =>
      this.terminateSessionForRevokedCredential(sessionId, 'route'),
    );
  }

  /**
   * Drains a deferred done-transition on the turn-boundary result event and,
   * if one was applied, reaps the session via endSession — a session parked
   * alive with the deferred transition now applied is terminal but may still
   * hold a live subprocess (the endSession call that markSessionDone's
   * in-flight guard originally deferred against never happened), so end it
   * via the same mechanism PRMergeWatcher used, now that it will succeed
   * against a terminal row instead of being refused.
   */
  private applyPendingDoneOnTurnBoundary(sessionId: string): void {
    if (!applyPendingDone(sessionId)) return;
    this.emit('message', {
      type: 'session_status',
      sessionId,
      status: 'done',
    } satisfies ServerMessage);
    this.endSession(sessionId);
  }

  /**
   * Override emit to intercept `message` events and emit `task_updated` whenever a
   * message could change a task's derived display status. Guards against re-entrant
   * calls so the task_updated broadcast itself never triggers another one.
   */
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    let emitArgs = args;
    if (event === 'message') {
      const msg = args[0] as ServerMessage;
      if (msg.type === 'session_event' && typeof msg.content === 'string') {
        const scrubbed = scrubSecrets(msg.content);
        if (scrubbed !== msg.content) {
          emitArgs = [{ ...msg, content: scrubbed }, ...args.slice(1)];
        }
      }
    }
    const result = super.emit(event, ...emitArgs);
    if (event === 'message' && !this._inTaskUpdate) {
      this._inTaskUpdate = true;
      try {
        this._handleTaskUpdated(emitArgs[0] as ServerMessage);
      } catch (err) {
        logger.error('[SessionManager] task_updated handler error:', err);
      } finally {
        this._inTaskUpdate = false;
      }
    }
    return result;
  }

  /**
   * Inspect an outgoing ServerMessage and, if it could change a task's derived
   * display status, re-derive and broadcast task_updated (de-duped by last known status).
   */
  private _handleTaskUpdated(msg: ServerMessage): void {
    const taskId = this._taskIdForMessage(msg);
    if (!taskId) return;

    const isLastMessageOnly = msg.type === 'session_event';

    if (isLastMessageOnly) {
      const last = this._lastMessageThrottle.get(taskId) ?? 0;
      const now = Date.now();
      if (now - last < LAST_MESSAGE_THROTTLE_MS) return;
      this._lastMessageThrottle.set(taskId, now);
    }

    const displayStatus = deriveDisplayStatusFromDb(taskId);
    const prev = this._lastDisplayStatus.get(taskId);

    if (!isLastMessageOnly && displayStatus === prev) return;
    if (isLastMessageOnly && displayStatus === prev) {
      // lastMessage-only and status unchanged — skip entirely (throttle already passed,
      // but there's nothing interesting to send)
      return;
    }

    this._lastDisplayStatus.set(taskId, displayStatus);
    emitTaskUpdated(taskId);
  }

  /**
   * Determine the task ID affected by a ServerMessage, if any.
   * Returns null for messages that cannot change task display status.
   */
  private _taskIdForMessage(msg: ServerMessage): string | null {
    switch (msg.type) {
      case 'session_starting':
      case 'session_started':
      case 'session_ended':
      case 'session_status':
      case 'session_event':
      case 'pr_created': {
        const sessionId = (msg as { sessionId: string }).sessionId;
        const row = getSession(sessionId);
        return row?.task_id ?? null;
      }
      case 'pr_review_complete':
      case 'review_verdict': {
        const { prNumber, repo } = msg as { prNumber: number; repo: string };
        const prRow = getPRByNumber(prNumber, repo);
        return prRow?.task_id ?? null;
      }
      case 'pr_merged':
      case 'pr_closed': {
        const { prNumber, repo } = msg as { prNumber: number; repo: string };
        const prRow = getPRByNumber(prNumber, repo);
        return prRow?.task_id ?? null;
      }
      default:
        return null;
    }
  }

  /**
   * Single owner of the (DB session status + Notion task status + WS broadcast) trio
   * for non-zero / killed exit paths. All call sites that previously called
   * updateSessionStatus(..., 'error'|'killed', ...) must go through this method.
   *
   * - Updates sessions.status and ended_at in the DB.
   * - Sets hasEnded on the in-memory AgentSession if still live.
   * - Emits session_ended WS broadcast.
   * - Records an audit_log event capturing the cause.
   * - For standard sessions with a task_id, updates the Notion task status:
   *   BLOCKED_REASONS causes use a crash budget: crash #1 → 🗂️ Ready (retryable),
   *   crash #2+ consecutive → 🚫 Blocked (circuit breaker). All other causes → 🗂️ Ready.
   * - Notion failures are logged but never re-thrown (matches handleCleanExit pattern).
   */
  markSessionErrored(
    sessionId: string,
    status: 'error' | 'killed',
    reason: string,
    detail?: string,
    opts?: { suppressReap?: boolean },
  ): void {
    const endedAt = Date.now();

    // Terminal guard: a row already concluded (done/error/killed) must never
    // be downgraded by a late-arriving exit signal — e.g.
    // sessionLivenessReconciler's SIGTERM reap of an orphaned process whose
    // row already completed, which fires this session's exit handler
    // outside the AgentSession object and thus outside its in-memory
    // hasEnded flag. Reads the persisted status directly instead, mirroring
    // markSessionIdle's terminal guard (db/queries.ts).
    const existingRow = getSession(sessionId);
    if (existingRow && TERMINAL_SESSION_STATUSES.has(existingRow.status)) {
      recordSessionErroredWriteSkipped(
        sessionId,
        existingRow.task_id ?? null,
        existingRow.status,
        status,
      );
      // Still flip hasEnded so AgentSession's own fallback direct-write path
      // (used only when sessionManager is absent) doesn't fire either.
      const liveSession = this.sessions.get(sessionId);
      if (liveSession) {
        liveSession.hasEnded = true;
      }
      return;
    }

    // 1. Update DB status and ended_at
    updateSessionStatus(sessionId, status, endedAt);
    setSessionTerminalCompletionReason(sessionId, reason);

    // A session ending is not a disposition of the staged intents it
    // already produced — a staged (or already operator-approved) intent
    // from a session that emitted a clean result must stay on the decision
    // surface after that session dies, so an operator can still act on it.
    // See "A killed session must not void the findings it already staged".
    // The only case still safe to auto-reap here is a session that never
    // staged anything of its own — reapStagedIntentsForNeverStagedSession
    // is an inert no-op for every other session.
    //
    // Exception: a grant-respawn kill is not a real death — the same session
    // id is about to come back with --resume, and its staged intents are
    // exactly the work it will continue. That caller passes
    // suppressReap:true for this single call only (never a persistent flag),
    // so a genuine kill of the same session later still runs this path.
    if (!opts?.suppressReap) {
      try {
        // Read the about-to-be-superseded rows before expiring them so the
        // resumed session can be told exactly what it lost — expiry itself
        // only flips state, it does not say who needs to know. Gated on the
        // actual reaped count, not just this list, because
        // reapStagedIntentsForNeverStagedSession only ever reaps a session
        // with zero staged_intent rows of its own — for which `expiring` is
        // always empty anyway, so this notice never fires in practice.
        const expiring = listStagedIntentsBySession(sessionId).filter(
          (intent) => intent.state === 'staged' || intent.state === 'approved',
        );
        const reapedCount = reapStagedIntentsForNeverStagedSession(
          sessionId,
          'session_killed_no_artifact',
          endedAt,
        );
        if (reapedCount > 0 && expiring.length > 0) {
          // Persist to the inbox only — do not go through the full
          // enqueueFeedback path here, which would attempt an immediate
          // terminal resume. A session that just went error/killed is not
          // necessarily coming back right now; the existing
          // delivery-on-resume paths (reconcileInboxAtBoot after
          // resumeOrphanSessions, redeliverUndeliveredFeedback) pick this up
          // naturally once it actually resumes.
          enqueueFeedbackItem(
            sessionId,
            'staged-intent-expiry',
            formatExpiredIntentsFeedback(expiring),
          );
        }
      } catch {
        // Best-effort — DB may be unavailable or mocked without this function.
      }
    }

    // Persist a concise reason so failures are diagnosable from the dashboard/DB
    // without reading raw session_events.
    if (detail) {
      try {
        setSessionLastErrorDetail(sessionId, detail);
      } catch {
        // Best-effort — DB may be unavailable or mocked without this function.
      }
    }

    // 2. Set hasEnded on live in-memory session to prevent double-broadcasts
    const liveSession = this.sessions.get(sessionId);
    if (liveSession) {
      liveSession.hasEnded = true;
    } else {
      // Session not live (already idle) — explicitly finalize the worktree now
      // that a terminal event has fired (e.g. PR closed).
      this._teardownIdleSessionWorktree(sessionId);
    }

    // 3. Look up session row for taskId — reuses the pre-write fetch from
    // the terminal guard above (task_id is immutable across the status
    // write, so a second lookup would be redundant).
    const row = existingRow;
    const taskId = row?.task_id ?? undefined;

    // 4. Emit session_ended WS broadcast
    this.emit('message', {
      type: 'session_ended',
      sessionId,
      status,
      ...(taskId && { taskId }),
    } satisfies ServerMessage);

    // 5. Record audit_log event capturing the cause
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: null,
      task_id: null,
      payload: { sessionId, status, reason },
    });

    // 7. Update Notion task status for standard sessions
    if (!row || !row.task_id) return;

    if (isPlanningSession(row.session_type)) {
      this.handlePlanningSessionCrash(row, reason, detail);
      return;
    }

    if (row.session_type !== 'standard') return;

    const notionTaskId = row.task_id;
    const projectId = row.project_id ?? '';

    let notionStatus: string;
    if (!UNCOUNTED_REASONS.has(reason)) {
      const crashCount = incrementTaskCrashCount(notionTaskId);
      if (crashCount >= 2) {
        notionStatus = '🚫 Blocked';
        // Persist the block so AutoLauncher skips this task across restarts.
        setTaskPauseReason(notionTaskId, 'launch_failed', reason);
        // Emit audit + broadcast so the dashboard reflects the block immediately.
        recordEvent({
          event_type: 'auto_launch_paused',
          actor_type: 'system',
          actor_id: sessionId,
          project_id: projectId || null,
          task_id: notionTaskId,
          payload: { reason, sessionId, crashCount },
        });
        this.emit('message', {
          type: 'auto_launch_paused',
          taskId: notionTaskId,
          reason: 'launch_failed',
          detail: reason,
        } satisfies ServerMessage);
      } else {
        notionStatus = '🗂️ Ready';
      }
    } else {
      notionStatus = '🗂️ Ready';
      // Notify AutoLauncher about launch failures so it can apply per-task
      // cooldown and escalate after repeated infra failures.
      if (reason === 'launch_failed') {
        this.emit('message', {
          type: 'session_launch_failed',
          taskId: notionTaskId,
          sessionId,
        } satisfies ServerMessage);
      }
    }

    // A dying session must never demote a task that already reached a
    // terminal state (Done/Deferred) — e.g. a user_kill arriving after the
    // PR merged should not revert the task to Ready. A cache miss/parse
    // failure falls back to the pre-existing revert behaviour so an
    // unreadable cache can never strand a task at In Progress.
    if (isTaskStatusTerminal(notionTaskId)) return;

    // A dying session must also never demote a task whose PR is already
    // open — the work already exists, a second dispatch cannot land it, and
    // both sessions would race the same branch. This is deliberately below
    // the crash-count/Blocked handling above: the crash-count increment and
    // the 🚫 Blocked pause-reason write (and its audit event/broadcast)
    // still happen even when a PR is open, since a task can legitimately
    // crash-loop while its PR sits open awaiting review and AutoLauncher
    // still needs to know. Only the visible task-status write is skipped
    // here, leaving the task at 👀 In Review rather than flipping it to
    // 🗂️ Ready or 🚫 Blocked. Merged/closed PRs are already covered above
    // via the task's terminal status.
    const openPr = getPRByNotionTaskId(notionTaskId);
    if (openPr && openPr.state === 'open') {
      recordTaskDemotionSkippedOpenPr(
        sessionId,
        notionTaskId,
        notionStatus,
        openPr.pr_number,
      );
      return;
    }

    // Update Notion task status (fire-and-forget; failures logged, not thrown)
    getTaskBackend(projectId)
      .updateStatus(notionTaskId, notionStatus, {
        source: 'orchestrator',
        sessionId,
      })
      .then(() => {
        this.emit('message', {
          type: 'task_status_changed',
          notionTaskId,
          newStatus: notionStatus,
        } satisfies ServerMessage);
        emitTaskUpdated(notionTaskId);
      })
      .catch((e) =>
        logger.error(
          `[SessionManager] markSessionErrored updateStatus failed: ${e}`,
        ),
      );
  }

  /**
   * Planning-session (groom/design/ops) crash handling, called from
   * markSessionErrored. Reuses the same task_crash_counts budget as the
   * standard-session path but maps it onto the planning lifecycle instead
   * of Ready/Blocked:
   * - Revert the mechanical In Progress move back to its launch-time status
   *   (design/groom → 🔲 Backlog, ops → 🗂️ Ready, since an ops task
   *   launches from Ready — a groom target never left Backlog, so there's
   *   nothing to revert for it).
   * - Crash #1 (transient): stays reverted with no needs_attention flag —
   *   retry-eligible.
   * - Crash #2+ (repeated): surface needs_attention via setTaskPauseReason,
   *   the planning analog of the standard-session's Blocked circuit breaker.
   * UNCOUNTED_REASONS (user_kill/pr_closed/launch_failed) never count
   * against the budget and never trigger a revert.
   */
  private handlePlanningSessionCrash(
    row: Session,
    reason: string,
    detail?: string,
  ): void {
    const taskId = row.task_id;
    if (!taskId || UNCOUNTED_REASONS.has(reason)) return;

    const projectId = row.project_id ?? '';

    if (movesTargetInProgress(row.session_type)) {
      const revertStatus =
        row.session_type === 'ops' ? '🗂️ Ready' : '🔲 Backlog';
      getTaskBackend(projectId)
        .updateStatus(taskId, revertStatus, {
          source: 'orchestrator',
          sessionId: row.session_id,
        })
        .then(() => {
          this.emit('message', {
            type: 'task_status_changed',
            notionTaskId: taskId,
            newStatus: revertStatus,
          } satisfies ServerMessage);
          emitTaskUpdated(taskId);
        })
        .catch((e) =>
          logger.error(
            `[SessionManager] failed to revert planning target to ${revertStatus}: ${e}`,
          ),
        );
    }

    const crashCount = incrementTaskCrashCount(taskId);
    if (crashCount < 2) return;

    const pauseReason = hasStagedIntentForTask(taskId)
      ? 'planning_crashed'
      : 'planning_terminal_no_decision';

    setTaskPauseReason(taskId, pauseReason, detail ?? reason);
    recordEvent({
      event_type: 'auto_launch_paused',
      actor_type: 'system',
      actor_id: row.session_id,
      project_id: projectId || null,
      task_id: taskId,
      payload: {
        reason: pauseReason,
        sessionId: row.session_id,
        crashCount,
      },
    });
    this.emit('message', {
      type: 'auto_launch_paused',
      taskId,
      reason: pauseReason,
      detail: detail ?? reason,
    } satisfies ServerMessage);
  }

  async start(
    taskUrl: string,
    projectContextUrl: string,
    options?: StartOptions,
  ): Promise<string> {
    const {
      taskType,
      sessionType = 'standard',
      projectId = '',
      taskName,
      sessionId: providedSessionId,
      taskKind,
      taskId: precomputedTaskId,
      docsTargetSurface,
    } = options ?? {};

    if (countsAgainstConcurrency(sessionType) && taskKind === undefined) {
      throw new Error(
        `sessionManager.start() requires taskKind for standard sessions`,
      );
    }

    // Planning session types (groom/design/ops) share one concurrency pool
    // distinct from the code session cap — they all compete for the same
    // operator review attention through one decision surface, so a per-type
    // cap would be the wrong shape here.
    if (isPlanningSession(sessionType)) {
      const planningSessionCount = [...this.sessions.values()].filter((s) =>
        isPlanningSession(s.sessionType),
      ).length;
      if (
        planningSessionCount >= runtimeSettings.max_concurrent_planning_sessions
      ) {
        throw new Error(
          `Max concurrent planning sessions (${runtimeSettings.max_concurrent_planning_sessions}) reached`,
        );
      }
    } else if (countsAgainstConcurrency(sessionType)) {
      // Reservation is taken in the same synchronous block as the check
      // (no await between) so concurrent start() calls can't all read the
      // same pre-insert count — this.sessions only gains the entry once
      // completeStart() finishes its (long, multi-await) worktree setup, so
      // pendingStarts is what makes a launch "count" immediately.
      const codeSessionCount =
        [...this.sessions.values()].filter((s) =>
          countsAgainstCodeSessionConcurrency(s.sessionType),
        ).length +
        [...this.pendingStarts.values()].filter((p) =>
          countsAgainstCodeSessionConcurrency(p.sessionType),
        ).length;
      if (codeSessionCount >= runtimeSettings.max_concurrent_code_sessions) {
        throw new Error(
          `Max concurrent code sessions (${runtimeSettings.max_concurrent_code_sessions}) reached`,
        );
      }
    }

    const project = getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const corporateMode = getCorporateMode();
    if (corporateMode.gates.requireZDR && !project.dataResidencyConfirmed) {
      recordEvent({
        event_type: 'session_launch_refused_zdr',
        actor_type: 'system',
        project_id: projectId,
        payload: {
          projectId,
          reason:
            'data_residency_confirmed is false; corporate mode requireZDR gate blocked session launch',
        },
      });
      throw new Error(
        `Session launch refused: project "${project.name}" has not confirmed Zero Data Retention (ZDR). ` +
          `Enable the Data Residency attestation in project Settings before launching sessions in corporate mode.`,
      );
    }

    // Dedup: if a live or DB-active session already exists for this task, return early.
    // This lifts the AutoLauncher guard into SessionManager so every caller benefits.
    // hasActiveSessionForTask/hasLiveSessionForTask only ever match standard
    // sessions (findLiveSessionIdForTask deliberately excludes planning
    // types — see its doc comment) — a groom/design/ops launch needs the
    // planning-aware equivalent alongside them, mirroring the same
    // eligibility rule isGroomCandidate/isDesignCandidate/isOpsCandidate use
    // (planningCandidates.ts) so candidate-scan-time and dispatch-time
    // dedup never disagree. idle is a live, non-terminal status (a session
    // parked awaiting operator disposition can be resumed at any moment), so
    // a single hasActivePlanningSessionForTask check — true for running OR
    // idle — is the whole guard; there is no idle-specific carve-out.
    if (countsAgainstConcurrency(sessionType)) {
      const earlyTaskId =
        precomputedTaskId ??
        deriveTaskId(project.taskSource ?? 'notion', taskUrl);
      const duplicatePlanning =
        sessionType === 'groom' ||
        sessionType === 'design' ||
        sessionType === 'ops'
          ? hasActivePlanningSessionForTask(earlyTaskId, sessionType)
          : false;
      if (
        this.hasLiveSessionForTask(earlyTaskId) ||
        hasActiveSessionForTask(earlyTaskId) ||
        duplicatePlanning
      ) {
        const existing = [...this.sessions.values()].find((s) => {
          const tid = s.taskId?.replace(/-/g, '');
          return tid && tid === earlyTaskId.replace(/-/g, '');
        });
        throw Object.assign(
          new Error(`Session already running for task ${earlyTaskId}`),
          { alreadyRunning: true, sessionId: existing?.sessionId ?? '' },
        );
      }
    }

    const sessionId = providedSessionId ?? crypto.randomUUID();
    const projectDir = normalizePath(project.projectDir);
    const worktreePath = path.join(
      projectDir,
      '.claude',
      'worktrees',
      sessionId,
    );
    const sessionTaskId =
      precomputedTaskId ??
      deriveTaskId(project.taskSource ?? 'notion', taskUrl);

    logger.info(
      `[SessionManager] start ${sessionId} project=${projectId} sessionType=${sessionType}`,
    );

    // Insert session into SQLite before firing background chain so FK constraints
    // on session_events are never violated. Planning sessions (groom/design/ops)
    // never get a worktree on disk (completeStart uses cwd=projectDir and skips
    // `git worktree add`) — persist null rather than a path that doesn't exist.
    const startedAt = Date.now();
    insertSession({
      session_id: sessionId,
      task_id: sessionTaskId,
      task_url: taskUrl,
      project_context_url: projectContextUrl,
      project_id: projectId,
      status: 'starting',
      started_at: startedAt,
      ended_at: null,
      pr_url: null,
      worktree_path: usesWorktree(sessionType, docsTargetSurface)
        ? worktreePath
        : null,
      session_type: sessionType,
      task_name: taskName ?? null,
    });

    // Seed the session-kind-keyed capability pre-grants (per-project
    // .claude-orchestrator.yml `capability_pre_grants`) before the session's
    // first turn — see orchestrator-config.ts#resolvePreGrantCapabilities.
    // Resolved from sessionType + sessionTaskId the same way
    // isGateVerifySession/isInvestigateSession derive their 'ops' sub-kinds,
    // and filtered through isGrantable before being written.
    const preGrantCapabilities = resolvePreGrantCapabilities(
      loadOrchestratorConfig(projectDir),
      sessionType,
      sessionTaskId,
    );
    if (preGrantCapabilities.length > 0) {
      seedGrantedCapabilities(sessionId, preGrantCapabilities);
    }

    // Captured once, here at spawn — never re-derived from a live task-body
    // fetch during the session's run (see StartOptions.declaredWrites doc
    // comment). respawnSession never calls this: it reconstructs an
    // in-memory AgentSession from the existing DB row, and the row's
    // metadata (set here, at original spawn) is left untouched across every
    // resume/restart, so a mid-session task-body edit can never widen an
    // already-dispatched session's auto-approve eligibility.
    if (options?.declaredWrites) {
      setSessionDeclaredWrites(sessionId, options.declaredWrites);
    }
    // Captured once, here at spawn, same rationale as declaredWrites above —
    // classifyWorktreeTeardownRefusal needs this after spawn (at teardown
    // time, from call sites that only have the DB row) to know whether this
    // 'docs' session was worktree-eligible, since usesWorktree('docs', ...)
    // depends on the Target surface, not sessionType alone.
    if (sessionType === 'docs' && docsTargetSurface) {
      setSessionDocsTargetSurface(sessionId, docsTargetSurface);
    }

    recordEvent({
      event_type: 'session_launched',
      actor_type: 'ai',
      actor_id: sessionId,
      project_id: projectId || null,
      task_id: sessionTaskId || null,
      payload: {
        session_type: sessionType,
        task_url: taskUrl,
        task_kind: taskKind,
      },
    });

    this.pendingStarts.set(sessionId, { sessionType });

    // Look up the PR for review sessions so the card can display "Review of #N".
    const reviewPr =
      sessionType === 'review' && sessionTaskId
        ? (getPRByNotionTaskId(sessionTaskId) ?? undefined)
        : undefined;
    const reviewPrNumber = reviewPr?.pr_number;
    const reviewCodeSessionId = reviewPr?.session_id ?? undefined;

    // Broadcast session_starting immediately — caller-observed completion is ~50ms.
    this.emit('message', {
      type: 'session_starting',
      sessionId,
      taskName: taskName ?? taskUrl,
      notionTaskUrl: taskUrl,
      ...(taskType != null && { taskType }),
      ...(sessionType !== 'standard' && { sessionType }),
      ...(reviewPrNumber != null && { prNumber: reviewPrNumber }),
      ...(reviewCodeSessionId != null && {
        codeSessionId: reviewCodeSessionId,
      }),
      started_at: startedAt,
      project_id: projectId,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      ...(sessionTaskId && { taskId: sessionTaskId }),
    } satisfies ServerMessage);

    // Fire-and-forget the heavy chain (git fetch → worktree add → bootstrap → spawn).
    // Caller-observed start() completion time is <100ms for the common case.
    void this.completeStart(
      sessionId,
      taskUrl,
      projectContextUrl,
      options ?? {},
      startedAt,
    ).catch(async (err) => {
      this.pendingStarts.delete(sessionId);
      const errorDetail = err instanceof Error ? err.message : String(err);
      logger.error(
        `[SessionManager] completeStart failed for ${sessionId}:`,
        errorDetail,
      );
      const isDegradedSpawn =
        err instanceof WorktreeSetupError && err.isDegradedSpawn;
      const pauseReason = isDegradedSpawn
        ? BACKEND_SPAWN_DEGRADED_REASON
        : 'launch_failed';
      // Persist the error context so review-verdict construction can surface the
      // real cause instead of the generic "no output to parse" fallback.
      try {
        setSessionPauseReason(sessionId, pauseReason);
        setSessionLastErrorDetail(sessionId, errorDetail);
      } catch {
        // Best-effort — DB may be unavailable or mocked without these functions.
      }
      await this.cleanupPartialWorktree(sessionId);
      this.markSessionErrored(sessionId, 'error', pauseReason);
      this.emit('message', {
        type: 'error',
        message: `Session launch failed: ${errorDetail}`,
      } satisfies ServerMessage);
    });

    return sessionId;
  }

  /**
   * Background chain: git fetch → worktree add → bootstrap → spawn runner.
   * Dispatched fire-and-forget from start(). Broadcasts session_started on success.
   * On failure, the catch handler in start() calls cleanupPartialWorktree + markSessionErrored.
   */
  private async completeStart(
    sessionId: string,
    taskUrl: string,
    projectContextUrl: string,
    options: StartOptions,
    startedAt: number,
  ): Promise<void> {
    const {
      taskType,
      sessionType = 'standard',
      customPrompt,
      projectId = '',
      taskName,
      milestoneId = null,
      taskId: precomputedTaskId,
      repo: resolvedRepo,
      opsContext,
      injectedProcedureContent,
      model: launchModel,
      effort: launchEffort,
      docsTargetSurface,
    } = options;

    const project = getProjectById(projectId)!;
    const projectDir = normalizePath(project.projectDir);
    const isPlanning = isPlanningSession(sessionType);
    // Worktree-eligible session types (standard, ops) get a real per-session
    // worktree + feature branch + bootstrap. The remaining planning types
    // (groom/design/split) are stage-only/read-only: cwd is the project's
    // own checkout (a read-only view in practice, since the base tool
    // profile has no write/mutate tools). docs is Target-surface-aware: a
    // repo-file Target surface (docsTargetSurface) is worktree-eligible like
    // ops, a Notion-page (or undeclared) one is stage-only like groom/design.
    const worktreeEligible = usesWorktree(sessionType, docsTargetSurface);
    const worktreePath = worktreeEligible
      ? path.join(projectDir, '.claude', 'worktrees', sessionId)
      : projectDir;
    const isLocalOnly = project.gitMode === 'local-only';
    const { startingPoint, milestoneSlug } = resolveStartingPoint(
      project,
      milestoneId,
    );
    const sessionTaskId =
      precomputedTaskId ??
      deriveTaskId(project.taskSource ?? 'notion', taskUrl);

    if (worktreeEligible) {
      if (!isLocalOnly) {
        if (milestoneSlug) {
          try {
            ensureMilestoneBranch(
              milestoneSlug,
              projectDir,
              project.baseBranch,
            );
          } catch (err) {
            logger.warn(
              `[SessionManager] ensureMilestoneBranch failed (continuing): ${err}`,
            );
          }
        } else {
          const fetchOutcome = await fetchBaseBranchCoalesced(
            projectDir,
            project.baseBranch,
          );
          if (!fetchOutcome.ok && fetchOutcome.benignRefLock) {
            logger.info(
              `[SessionManager] git fetch origin ${project.baseBranch} lost a ref-lock race but the ref already holds the fetched value (continuing): ${fetchOutcome.error}`,
            );
            recordEvent({
              event_type: 'base_fetch_ref_lock_benign',
              actor_type: 'system',
              actor_id: sessionId,
              project_id: projectId || null,
              task_id: sessionTaskId || null,
              payload: {
                baseBranch: project.baseBranch,
                error: String(fetchOutcome.error),
              },
            });
          } else if (!fetchOutcome.ok) {
            logger.warn(
              `[SessionManager] git fetch origin ${project.baseBranch} failed (continuing with local ref): ${fetchOutcome.error}`,
            );
            setSessionLastErrorDetail(
              sessionId,
              `Pre-launch fetch of origin/${project.baseBranch} failed; session may be starting from a stale base: ${fetchOutcome.error}`,
            );
            recordEvent({
              event_type: 'base_fetch_failed',
              actor_type: 'system',
              actor_id: sessionId,
              project_id: projectId || null,
              task_id: sessionTaskId || null,
              payload: {
                baseBranch: project.baseBranch,
                error: String(fetchOutcome.error),
              },
            });
          }
        }
      }

      const worktreeBase =
        isLocalOnly || startingPoint !== project.baseBranch
          ? startingPoint
          : `origin/${project.baseBranch}`;

      const featureBranch = taskName
        ? resolveAvailableBranchSlug(
            deriveBranchSlug(taskName, sessionTaskId),
            projectDir,
          )
        : null;
      if (featureBranch) {
        try {
          await gitWorktreeAddWithRetry(
            `git worktree add -b "${featureBranch}" "${worktreePath}" ${worktreeBase}`,
            { cwd: projectDir },
          );
          setSessionFeatureBranch(sessionId, featureBranch);
        } catch (err) {
          const e = err as { stderr?: string | Buffer; message: string };
          const stderr = e.stderr ? e.stderr.toString() : '';
          const isBranchAlreadyExists = /A branch named .* already exists/.test(
            stderr,
          );
          const fullMsg =
            `${e.message}${stderr ? `\nstderr: ${stderr}` : ''}`.trim();

          if (isBranchAlreadyExists) {
            // Identify the branch owner: look for a terminal predecessor session of the same task.
            const predecessors = getTerminalSessionsForTask(sessionTaskId);
            const predecessor = predecessors[0] ?? null;

            if (predecessor) {
              // Owned by a terminal predecessor of the same task — abandon and retry fresh.
              logger.info(
                `[SessionManager] completeStart: stale branch ${featureBranch} from terminal session ${predecessor.session_id.slice(0, 8)} — abandoning`,
              );

              // Close the predecessor's open PR with a superseded comment (best-effort).
              let prNumber: number | null = null;
              let prRepo: string | null = null;
              const prRow = getPRBySessionId(predecessor.session_id);
              if (prRow && prRow.state === 'open' && this.githubClient) {
                prNumber = prRow.pr_number;
                prRepo = prRow.repo;
                try {
                  await this.githubClient.closePRWithComment(
                    prRow.repo,
                    prRow.pr_number,
                    "Superseded — task relaunched; this PR's branch was abandoned per fresh-start policy.",
                  );
                  logger.info(
                    `[SessionManager] completeStart: closed predecessor PR #${prRow.pr_number} (${prRow.repo})`,
                  );
                } catch (closeErr) {
                  logger.warn(
                    `[SessionManager] completeStart: failed to close predecessor PR #${prRow.pr_number}: ${closeErr}`,
                  );
                }
              }

              // Prune stale worktree registrations before local branch delete.
              try {
                execSync(`git worktree prune`, { cwd: projectDir });
              } catch {
                // best-effort
              }

              // Delete the branch locally (best-effort).
              try {
                execSync(`git branch -D "${featureBranch}"`, {
                  cwd: projectDir,
                });
                logger.info(
                  `[SessionManager] completeStart: deleted local branch ${featureBranch}`,
                );
              } catch (delLocalErr) {
                logger.warn(
                  `[SessionManager] completeStart: failed to delete local branch ${featureBranch}: ${delLocalErr}`,
                );
              }

              // Delete the branch on origin (best-effort).
              const branchDeletionRepo = resolvedRepo ?? project.githubRepo;
              if (this.githubClient && branchDeletionRepo) {
                try {
                  await this.githubClient.deleteBranch(
                    branchDeletionRepo,
                    featureBranch,
                  );
                  logger.info(
                    `[SessionManager] completeStart: deleted origin branch ${featureBranch}`,
                  );
                } catch (delRemoteErr) {
                  logger.warn(
                    `[SessionManager] completeStart: failed to delete origin branch ${featureBranch}: ${delRemoteErr}`,
                  );
                }
              }

              // Emit stale_branch_abandoned audit event.
              recordEvent({
                event_type: 'stale_branch_abandoned',
                actor_type: 'system',
                actor_id: sessionId,
                project_id: projectId || null,
                task_id: sessionTaskId || null,
                payload: {
                  branch: featureBranch,
                  priorSessionId: predecessor.session_id,
                  prNumber,
                  prRepo,
                },
              });

              // Single retry — if this also fails, propagate normally (no loop).
              try {
                await gitWorktreeAddWithRetry(
                  `git worktree add -b "${featureBranch}" "${worktreePath}" ${worktreeBase}`,
                  { cwd: projectDir },
                );
                setSessionFeatureBranch(sessionId, featureBranch);
              } catch (retryErr) {
                const re = retryErr as {
                  stderr?: string | Buffer;
                  message: string;
                };
                const retryStderr = re.stderr ? re.stderr.toString() : '';
                const retryMsg =
                  `${re.message}${retryStderr ? `\nstderr: ${retryStderr}` : ''}`.trim();
                logger.error(
                  `[SessionManager] completeStart: retry after stale-branch abandonment also failed for ${sessionId}: ${retryMsg}`,
                );
                throw buildWorktreeSetupError(retryErr, retryMsg, false);
              }
            } else {
              // Branch exists but not attributable to a terminal predecessor of this task.
              // Keep deterministic failure — crash budget backstop handles it.
              logger.error(
                `[SessionManager] failed to create worktree for ${sessionId}: ${fullMsg}`,
              );
              throw buildWorktreeSetupError(
                err,
                fullMsg,
                isBranchAlreadyExists,
              );
            }
          } else {
            logger.error(
              `[SessionManager] failed to create worktree for ${sessionId}: ${fullMsg}`,
            );
            throw buildWorktreeSetupError(err, fullMsg, isBranchAlreadyExists);
          }
        }
      } else {
        try {
          await gitWorktreeAddWithRetry(
            `git worktree add --detach "${worktreePath}" ${worktreeBase}`,
            { cwd: projectDir },
          );
        } catch (err) {
          const e = err as { stderr?: string | Buffer; message: string };
          const stderr = e.stderr ? e.stderr.toString() : '';
          const fullMsg =
            `${e.message}${stderr ? `\nstderr: ${stderr}` : ''}`.trim();
          logger.error(
            `[SessionManager] failed to create worktree for ${sessionId}: ${fullMsg}`,
          );
          throw buildWorktreeSetupError(err, fullMsg, false);
        }
      }

      const isUnixStylePath =
        worktreePath.startsWith('/c/') || worktreePath.startsWith('/C/');
      logger.info(
        `[SessionManager] worktree created: path=${worktreePath} startingPoint=${startingPoint}` +
          (isUnixStylePath
            ? ' [WARNING: Unix-style path detected — may not resolve correctly on Windows]'
            : ''),
      );
    }

    const orchConfig = loadOrchestratorConfig(projectDir);

    if (worktreeEligible && orchConfig.bootstrap_script) {
      const dependencyCachePoolConfigured =
        (orchConfig.dependency_lock_paths?.length ?? 0) > 0 &&
        (orchConfig.dependency_cache_dirs?.length ?? 0) > 0 &&
        !!orchConfig.dependency_verify_command;

      let handledByCachePool = false;
      if (dependencyCachePoolConfigured) {
        const cachePoolStart = Date.now();
        try {
          handledByCachePool = await tryDependencyCachePool({
            projectId,
            projectDir,
            worktreePath,
            bootstrapScript: orchConfig.bootstrap_script,
            lockPaths: orchConfig.dependency_lock_paths,
            cacheDirs: orchConfig.dependency_cache_dirs,
            verifyCommand: orchConfig.dependency_verify_command,
            sessionId,
          });
          if (handledByCachePool) {
            logger.info(
              `[SessionManager] dependency bootstrap duration: path=cache-pool session=${sessionId.slice(0, 8)} durationMs=${Date.now() - cachePoolStart}`,
            );
          }
        } catch (err) {
          logger.warn(
            `[SessionManager] dependency cache pool errored for ${sessionId.slice(0, 8)}, falling back to bootstrap_script: ${err}`,
          );
          handledByCachePool = false;
        }
      }

      if (handledByCachePool) {
        logger.info(
          `[SessionManager] dependency cache pool provisioned dependencies for ${sessionId.slice(0, 8)}`,
        );
      } else {
        const bootstrapStart = Date.now();
        try {
          await exec(
            `bash "${orchConfig.bootstrap_script}" "${worktreePath}"`,
            {
              cwd: projectDir,
              timeout: 120_000,
            },
          );
          logger.info(
            `[SessionManager] bootstrap script completed for ${sessionId.slice(0, 8)}`,
          );
          logger.info(
            `[SessionManager] dependency bootstrap duration: path=fallback session=${sessionId.slice(0, 8)} durationMs=${Date.now() - bootstrapStart}`,
          );
        } catch (err) {
          const e = err as { stderr?: string | Buffer; message?: string };
          const stderr = e.stderr ? e.stderr.toString().slice(0, 500) : '';
          const detail = `bootstrap failed: ${stderr || String(err)}`;
          logger.error(
            `[SessionManager] ${detail} for ${sessionId.slice(0, 8)} — aborting launch`,
          );
          throw Object.assign(new Error(detail), { cause: err });
        }
      }
    }

    const missingEnv = worktreeEligible
      ? orchConfig.required_env.filter((varName) => !(varName in process.env))
      : [];
    if (missingEnv.length > 0) {
      const detail = `bootstrap gate: missing required env var(s): ${missingEnv.join(', ')}`;
      logger.error(
        `[SessionManager] ${detail} for ${sessionId.slice(0, 8)} — aborting launch`,
      );
      throw new Error(detail);
    }

    const missingFiles = worktreeEligible
      ? orchConfig.required_files.filter(
          (filePath) => !fs.existsSync(path.join(worktreePath, filePath)),
        )
      : [];
    if (missingFiles.length > 0) {
      const detail = `bootstrap gate: missing required file(s): ${missingFiles.join(', ')}`;
      logger.error(
        `[SessionManager] ${detail} for ${sessionId.slice(0, 8)} — aborting launch`,
      );
      throw new Error(detail);
    }

    const sessionMode = runtimeSettings.session_mode;
    const runner =
      sessionMode === 'api'
        ? new ApiSessionRunner(sessionId)
        : getCorporateMode().gates.dockerMandatory
          ? new DockerSessionRunner(sessionId)
          : new CliSessionRunner(sessionId);

    let taskContent: string | undefined;
    if (
      countsAgainstConcurrency(sessionType) &&
      sessionTaskId &&
      !isGateVerifySession(sessionTaskId)
    ) {
      try {
        taskContent =
          await getTaskBackend(projectId).fetchTaskPage(sessionTaskId);
        logger.info(
          `[SessionManager] pre-fetched task content for ${sessionId.slice(0, 8)} (${taskContent.length} chars)`,
        );
      } catch (err) {
        logger.warn(
          `[SessionManager] failed to pre-fetch task content for ${sessionId.slice(0, 8)} — session will fetch from task backend: ${err}`,
        );
      }
    }

    if (taskContent) {
      try {
        const fileSnippets = readTaskFiles(taskContent, projectDir);
        if (fileSnippets) {
          taskContent += '\n\n' + fileSnippets;
          logger.info(
            `[SessionManager] appended file snippets for ${sessionId.slice(0, 8)}`,
          );
        }
      } catch (err) {
        logger.warn(
          `[SessionManager] failed to read task files for ${sessionId.slice(0, 8)}: ${err}`,
        );
      }
    }

    if (opsContext) {
      taskContent = taskContent
        ? `${taskContent}\n\n${opsContext}`
        : opsContext;
      logger.info(
        `[SessionManager] appended ops context for ${sessionId.slice(0, 8)}`,
      );
    }

    let sessionContextContent: string | undefined;
    if (isPlanning && injectedProcedureContent) {
      // Planning sessions dispatched with an assembled procedure (see
      // planning/procedureAssembler.ts) skip buildOrchestratorClaudeMd
      // entirely — the assembler's skeleton already carries the
      // session-lifecycle/transport rules that builder would inject.
      sessionContextContent = injectedProcedureContent;
    } else if (sessionType === 'review') {
      sessionContextContent = buildReviewClaudeMd(
        taskName ?? taskUrl,
        orchConfig.review_rules.length > 0
          ? orchConfig.review_rules
          : undefined,
      );
    } else if (sessionType === 'depth_review') {
      sessionContextContent = buildDepthReviewClaudeMd(taskName ?? taskUrl);
    } else if (isPlanning) {
      // A planning/ops session (groom/design/ops) with no assembled procedure
      // is a dispatch mis-wire, not a case to silently paper over: falling
      // through to buildOrchestratorClaudeMd would inject the implement →
      // branch → Pre-PR Gate → open-PR → review-loop coding scaffold into a
      // worktree-less, often read-only session. Fail loud instead so the
      // caller that forgot to assemble+pass injectedProcedureContent is
      // surfaced immediately rather than the session quietly running the
      // wrong procedure.
      throw new Error(
        `[SessionManager] planning/ops session (sessionType=${sessionType}) dispatched ` +
          `for ${sessionId.slice(0, 8)} with no injectedProcedureContent — refusing to ` +
          'fall back to buildOrchestratorClaudeMd',
      );
    } else {
      try {
        sessionContextContent = buildSessionContext({
          taskName: taskName ?? taskUrl,
          taskUrl,
          projectContextUrl,
          targetBranch: startingPoint,
          projectDir,
          worktreePath,
          verify: orchConfig.verify.length > 0 ? orchConfig.verify : undefined,
          bashRules:
            orchConfig.bash_rules.length > 0
              ? orchConfig.bash_rules
              : undefined,
          sessionRules:
            orchConfig.session_rules.length > 0
              ? orchConfig.session_rules
              : undefined,
          taskBackend:
            project.taskSource === 'yaml'
              ? 'local'
              : project.taskSource === 'github'
                ? 'github'
                : project.taskSource === 'jira'
                  ? 'jira'
                  : 'notion',
          taskContent,
          gitMode: project.gitMode,
        });
      } catch (err) {
        logger.error(
          `[SessionManager] failed to build session context for ${sessionId}: ${err}`,
        );
      }
    }

    const mcpConfigPath = writeMcpConfig(
      projectDir,
      sessionId,
      orchConfig.mcp_servers,
      project.taskSource,
    );
    if (mcpConfigPath) {
      logger.info(
        `[SessionManager] wrote MCP config to ${mcpConfigPath} for ${sessionId.slice(0, 8)}`,
      );
    }

    let systemPromptFilePath: string | undefined;
    if (sessionMode === 'cli' && sessionContextContent) {
      systemPromptFilePath = writeSystemPromptFile(
        projectDir,
        sessionId,
        sessionContextContent,
      );
      logger.info(
        `[SessionManager] system prompt written to ${systemPromptFilePath} for ${sessionId.slice(0, 8)}`,
      );
    }

    const session = new AgentSession(
      sessionId,
      taskUrl,
      projectContextUrl,
      undefined,
      worktreePath,
      sessionTaskId,
      undefined,
      customPrompt,
      sessionType,
      this,
      this.githubClient,
      orchConfig.allowed_tools,
      sessionMode === 'api' ? sessionContextContent : undefined,
      runner,
      projectId,
      mcpConfigPath,
      systemPromptFilePath,
      launchModel,
      launchEffort,
    );

    this.pendingStarts.delete(sessionId);
    this.sessions.set(sessionId, session);

    // From here, this Map entry's slot is only released by session.run()'s
    // own settle handlers (wireSession's .then/.catch → cleanupWorktree,
    // SessionManager.ts:2664/:3938) — and those only run once wireSession()
    // has been called without throwing, i.e. once the subprocess is actually
    // spawning. A throw anywhere in this block (PR lookup, event emission,
    // wireSession() itself) happens before that handoff, so nothing would
    // ever reap the entry — it would hold its slot until a backend restart.
    // spawnStarted tracks whether the handoff happened; the finally below
    // releases the slot unconditionally whenever it didn't.
    let spawnStarted = false;
    try {
      // Look up the PR for review sessions so session_started carries prNumber.
      const reviewPr =
        sessionType === 'review' && sessionTaskId
          ? (getPRByNotionTaskId(sessionTaskId) ?? undefined)
          : undefined;
      const reviewPrNumber = reviewPr?.pr_number;
      const reviewCodeSessionId = reviewPr?.session_id ?? undefined;

      // Broadcast session_started BEFORE wireSession() — wireSession calls
      // session.run(), which synchronously broadcasts a session_status
      // ('running') message as its first statement. If session_started were
      // emitted after wireSession(), that running update could reach clients
      // before session_started, get dropped (unknown session), and leave the
      // session stuck showing "starting" until a refresh re-reads the DB.
      this.emit('message', {
        type: 'session_started',
        sessionId,
        taskName: taskName ?? taskUrl,
        notionTaskUrl: taskUrl,
        ...(taskType != null && { taskType }),
        ...(sessionType !== 'standard' && { sessionType }),
        ...(reviewPrNumber != null && { prNumber: reviewPrNumber }),
        ...(reviewCodeSessionId != null && {
          codeSessionId: reviewCodeSessionId,
        }),
        started_at: startedAt,
        project_id: projectId,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        grantedCapabilities: getGrantedCapabilities(sessionId),
        ...(sessionTaskId && { taskId: sessionTaskId }),
      } satisfies ServerMessage);

      this.wireSession(sessionId, session, projectDir, worktreePath);
      spawnStarted = true;

      // Update task status to In Progress (fire-and-forget; failures logged, not thrown).
      if (
        movesTargetInProgress(sessionType) &&
        !isGateVerifySession(sessionTaskId)
      ) {
        getTaskBackend(projectId)
          .updateStatus(sessionTaskId, '🔄 In Progress', {
            source: 'orchestrator',
            sessionId,
          })
          .then(() => {
            this.emit('message', {
              type: 'task_status_changed',
              notionTaskId: sessionTaskId,
              newStatus: '🔄 In Progress',
            } satisfies ServerMessage);
            emitTaskUpdated(sessionTaskId);
          })
          .catch((e) => {
            logger.error(`[SessionManager] failed to set In Progress: ${e}`);
            this.emit('message', {
              type: 'error',
              message: `Failed to update task status to In Progress: ${e}`,
            } satisfies ServerMessage);
          });
      }
    } finally {
      if (!spawnStarted) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Remove a partially-created worktree and its feature branch after a failed
   * completeStart() (e.g. a transient launch_failed). Safe to call even if
   * nothing was created (idempotent).
   *
   * A `git worktree add -b <branch> <path>` that fails partway can leave the
   * environment in any of these states:
   *   - the worktree directory exists and is registered,
   *   - the directory is gone but a *stale registration* remains,
   *   - the branch was created even though the worktree wasn't.
   * If any of these survive, the cooldown retry's `git worktree add` re-fails
   * with "A branch named X already exists" — defeating the backoff. So we
   * unconditionally: (1) remove the worktree if its dir exists, (2) prune stale
   * registrations, then (3) delete the feature branch. Steps run in that order
   * because a branch checked out in a (possibly stale) worktree can't be
   * deleted until the worktree/registration is gone.
   */
  private async cleanupPartialWorktree(sessionId: string): Promise<void> {
    const row = getSession(sessionId);
    if (!row) return;

    const project = getProjectById(row.project_id ?? '');
    if (!project) return;

    const projectDir = normalizePath(project.projectDir);
    const worktreePath = row.worktree_path;
    // Planning sessions (groom/design/ops) run directly in the project checkout —
    // never remove it as if it were a disposable worktree.
    if (!worktreePath || !isRemovableWorktree(worktreePath, projectDir)) {
      if (worktreePath) {
        const docsTargetSurface =
          row.session_type === 'docs'
            ? getSessionDocsTargetSurface(sessionId)
            : undefined;
        const classification = classifyWorktreeTeardownRefusal(
          row.session_type || 'standard',
          worktreePath,
          projectDir,
          docsTargetSurface,
        );
        if (classification.expected) {
          logger.debug(
            `[SessionManager] cleanupPartialWorktree: expected worktree-less refusal for ${sessionId.slice(0, 8)} (planning session, no worktree owned)`,
          );
        } else {
          recordEvent({
            event_type: 'worktree_teardown_refused',
            actor_type: 'system',
            actor_id: sessionId,
            project_id: null,
            task_id: null,
            payload: {
              sessionId,
              worktreePath,
              projectDir,
              source: 'cleanupPartialWorktree',
              expected: classification.expected,
              reason: classification.reason,
            } satisfies WorktreeTeardownRefusedPayload,
          });
        }
      }
      return;
    }

    if (fs.existsSync(worktreePath)) {
      try {
        await exec(`git worktree remove --force "${worktreePath}"`, {
          cwd: projectDir,
        });
        logger.info(
          `[SessionManager] cleanupPartialWorktree: removed worktree for ${sessionId.slice(0, 8)}`,
        );
      } catch (err) {
        logger.warn(
          `[SessionManager] cleanupPartialWorktree: worktree remove failed for ${sessionId.slice(0, 8)}: ${err}`,
        );
      }
    }

    // Prune stale worktree registrations (covers the dir-gone-but-registered
    // case that the existsSync guard above skips) so a retry's `git worktree
    // add` and the branch delete below aren't blocked by a phantom checkout.
    try {
      await exec(`git worktree prune`, { cwd: projectDir });
    } catch {
      // Best-effort — nothing to prune is a no-op
    }

    // Only ever delete the branch this session itself created (persisted at
    // worktree-add time) — never re-derive the default name here. A
    // uniquified launch's default name may belong to an unrelated orphaned
    // branch from a dead prior session, and re-deriving would delete that
    // stranger's branch instead of this session's own.
    const featureBranch = row.feature_branch;
    if (featureBranch) {
      try {
        await exec(`git branch -D "${featureBranch}"`, { cwd: projectDir });
        logger.info(
          `[SessionManager] cleanupPartialWorktree: deleted branch ${featureBranch} for ${sessionId.slice(0, 8)}`,
        );
      } catch {
        // Branch does not exist — idempotent no-op
      }
    }
  }

  /**
   * Apply a done-transition deferred (while this session's turn was in
   * flight) by markSessionDone, now that the turn has genuinely completed —
   * called only from wireSession's run()-settle handlers, never speculatively.
   * Broadcasts session_status when a deferred done is actually applied so the
   * UI reflects it even though the write happened outside the normal
   * markSessionDone call site's own broadcast.
   */
  private applyPendingDoneForSettledSession(sessionId: string): void {
    if (applyPendingDone(sessionId)) {
      this.emit('message', {
        type: 'session_status',
        sessionId,
        status: 'done',
      } satisfies ServerMessage);
    }
  }

  /**
   * Wire up event forwarding and fire-and-forget run() for a session.
   * Used by both start() and resumeSession() to avoid duplicating this logic.
   */
  private wireSession(
    sessionId: string,
    session: AgentSession,
    projectDir: string,
    worktreePath: string,
  ): void {
    // Forward all session events to the WS layer via EventEmitter
    session.on('message', (msg: ServerMessage) => this.emit('message', msg));
    // PR-attribution guard: warn when a session opens a PR for a different task
    // than the one it was dispatched for, then still forward so the PR is tracked.
    session.on('pr_opened', (job: unknown) => {
      const prJob = job as {
        taskId?: string;
        prNumber?: number;
        repo?: string;
      };
      logger.info(
        `[SessionManager] forwarding pr_opened for PR #${prJob.prNumber ?? '?'} (${prJob.repo ?? '?'}) from session ${sessionId.slice(0, 8)}`,
      );
      const dispatched = session.taskId;
      if (
        dispatched &&
        prJob.taskId &&
        prJob.taskId.replace(/-/g, '') !== dispatched.replace(/-/g, '')
      ) {
        logger.error(
          `[SessionManager] PR attribution mismatch: session ${sessionId.slice(0, 8)} dispatched for ${dispatched} but PR is attributed to ${prJob.taskId}`,
        );
        recordEvent({
          event_type: 'pr_attribution_mismatch',
          actor_type: 'system',
          actor_id: sessionId,
          project_id: null,
          task_id: dispatched,
          payload: { dispatchedTaskId: dispatched, prTaskId: prJob.taskId },
        });
      }
      logger.info(
        `[SessionManager] emitting pr_opened to ReviewOrchestrator for PR #${prJob.prNumber ?? '?'}`,
      );
      this.emit('pr_opened', job);
    });
    // Forward push_detected so ReviewOrchestrator can trigger re-reviews
    session.on('push_detected', (payload: unknown) =>
      this.emit('push_detected', payload),
    );
    // Forward dispositions_parsed so ReviewOrchestrator can drive reply/resolve actions
    session.on('dispositions_parsed', (payload: unknown) =>
      this.emit('dispositions_parsed', payload),
    );
    // Forward verified_flaky_disposition so PRMergeWatcher can actuate a same-SHA re-run
    session.on('verified_flaky_disposition', (payload: unknown) =>
      this.emit('verified_flaky_disposition', payload),
    );
    // Forward review_verdict_recorded so PRReviewService.waitForVerdict can
    // resolve directly from the review.verdict MCP tool instead of only via
    // its text/session_ended fallback parse.
    session.on('review_verdict_recorded', (payload: unknown) =>
      this.emit('review_verdict_recorded', payload),
    );
    // Forward gate_verify_disposition so the GateItemVerifier awaiting this
    // dispatched session's terminal report can resolve.
    session.on('gate_verify_disposition', (payload: unknown) =>
      this.emit('gate_verify_disposition', payload),
    );
    // Forward deploy_agentic_verdict so the deploy-agentic-step spawner
    // awaiting this dispatched session's report can settle the deploy step.
    session.on('deploy_agentic_verdict', (payload: unknown) =>
      this.emit('deploy_agentic_verdict', payload),
    );

    // Fire-and-forget — run() blocks until the subprocess exits, then clean up
    session
      .run()
      .then(() => {
        // The turn has now genuinely completed (process exited). Apply any
        // done-transition that markSessionDone deferred while this turn was
        // in flight — see markSessionDone's in-flight guard in db/queries.ts.
        this.applyPendingDoneForSettledSession(sessionId);
        if (
          isPlanningSession(session.sessionType) &&
          !usesWorktree(session.sessionType)
        ) {
          this.checkPlanningSessionDrift(sessionId, session.taskId, projectDir);
        }
        return this.cleanupWorktree(
          sessionId,
          worktreePath,
          session.prUrl,
          projectDir,
        );
      })
      .catch((err) => {
        logger.error(`[SessionManager] session ${sessionId} error: ${err}`);
        // If run() threw before broadcasting session_ended, update SQLite and
        // notify the frontend so the session doesn't stay stuck at 'running'.
        if (!session.hasEnded) {
          const detail = err instanceof Error ? err.message : String(err);
          this.markSessionErrored(sessionId, 'error', 'run_error', detail);
        }
        this.applyPendingDoneForSettledSession(sessionId);
        if (
          isPlanningSession(session.sessionType) &&
          !usesWorktree(session.sessionType)
        ) {
          this.checkPlanningSessionDrift(sessionId, session.taskId, projectDir);
        }
        return this.cleanupWorktree(
          sessionId,
          worktreePath,
          undefined,
          projectDir,
        );
      });
  }

  /**
   * Shared respawn helper used by every caller that revives a dead/orphaned
   * session — resumeSession (boot recovery), sendOrResume (verdict/feedback
   * routing to a dead session), and respawnForCapabilityGrant.
   *
   * The usage-admission check is applied here rather than in each caller so
   * that every current and future respawn path is covered without having to
   * remember to wire the check in individually — see isUsageAdmitted's
   * callers elsewhere (AutoLauncher, DispatchTriggerEvaluator) for the
   * launch-side half of the usage gate. Memory admission is deliberately
   * NOT applied here: it bounds the creation of new work
   * (AutoLauncher.hasCapacity()), not resuming a session that already
   * exists — see memoryAdmission.ts's doc comment. A deferral is not a
   * failure: nothing is spawned and the session row is left exactly as-is
   * (whatever status it already had) so a later pass (poller recovery,
   * operator retry, resumeOrphanSessions on next boot) can respawn once the
   * deferral expires.
   * Returns null when deferred; callers must not touch the DB row or kill the
   * session in that case.
   *
   * Creates an AgentSession reusing the original session ID, registers it in
   * the sessions map, updates the DB row to 'running', and emits session_status.
   * Does NOT call wireSession — callers must register any once-listeners on the
   * returned session BEFORE calling wireSession so there is no race with run().
   */
  private respawnSession(
    row: Session,
    worktreePath: string,
    orchConfig: ReturnType<typeof loadOrchestratorConfig>,
    runner: ISessionRunner,
    mcpConfigPath: string | undefined,
    systemPromptFilePath?: string,
    opts: { allowReopenTerminal?: boolean } = {},
  ): AgentSession | null {
    this.lastRespawnDeferral = null;
    const usageAdmission = isUsageAdmitted();
    if (!usageAdmission.allowed) {
      logger.warn(
        `[SessionManager] respawnSession: deferring ${row.session_id.slice(0, 8)} — plan usage (${usageAdmission.window}) exhausted until ${usageAdmission.deferredUntil ? new Date(usageAdmission.deferredUntil).toISOString() : 'unknown'}`,
      );
      if (row.task_id) {
        setTaskPauseReason(
          row.task_id,
          'usage_limit_deferred',
          usageAdmission.window ?? 'unknown',
        );
      }
      this.lastRespawnDeferral = {
        reason: 'usage_limit_deferred',
        detail: 'Plan usage window exhausted — deferring resume.',
      };
      return null;
    }

    // Memory admission bounds the creation of new work (AutoLauncher's fresh
    // dispatch decision) — it does not gate resuming a session that already
    // exists. That work (worktree, branch, conversation) is already on disk
    // and already paid for; refusing the transition only strands it. Any
    // sweep capable of triggering many resumes in one pass (e.g.
    // AutoMerger.conflictNudgeSweep()) must bound its own fan-out instead of
    // relying on this shared transition to do it.

    const session = new AgentSession(
      row.session_id,
      row.task_url ?? '',
      row.project_context_url ?? '',
      undefined,
      worktreePath,
      row.task_id ?? '',
      row.session_id, // resumeSessionId — passes --resume to CLI / SDK
      undefined,
      row.session_type ?? 'standard',
      this,
      this.githubClient,
      orchConfig.allowed_tools,
      undefined,
      runner,
      row.project_id ?? '',
      mcpConfigPath,
      systemPromptFilePath,
      undefined,
      undefined,
      // hasInitialPrompt=false — every respawnSession call constructs with
      // resumeSessionId set (--resume), so no prompt is ever actually sent
      // at spawn; see AgentSession's hasInitialPrompt param.
      false,
    );
    if (row.pr_url) session.prUrl = row.pr_url;
    this.sessions.set(row.session_id, session);
    // Update (not insert) the existing DB row — the session is resuming in-place.
    //
    // Terminal is sticky: a done/error/killed row must not be silently
    // overwritten with 'running' by a resume. The only way in is an explicit,
    // audited reopen (opts.allowReopenTerminal — threaded from sendOrResume's
    // allowTerminal, used by relaunchFixerForPR / terminal feedback-delivery),
    // never an implicit side effect of respawning a process.
    const isTerminal = TERMINAL_SESSION_STATUSES.has(row.status);
    if (isTerminal && !opts.allowReopenTerminal) {
      logger.warn(
        `[SessionManager] respawnSession: refusing to overwrite terminal status '${row.status}' with running for ${row.session_id.slice(0, 8)}`,
      );
    } else {
      if (isTerminal) {
        recordEvent({
          event_type: 'session_terminal_reopened',
          actor_type: 'system',
          actor_id: row.session_id,
          task_id: row.task_id ?? null,
          payload: { status_before: row.status },
        });
      }
      updateSessionStatus(row.session_id, 'running');
      this.emit('message', {
        type: 'session_status',
        sessionId: row.session_id,
        status: 'running',
      } satisfies ServerMessage);
    }
    // Checkout-only planning sessions (groom/design/ops-without-worktree/
    // split-without-worktree) never own a real per-session worktree —
    // start() persists worktree_path=null for them (see the comment at
    // insertSession's call site). Callers of respawnSession resolve a local
    // fallback cwd (typically projectDir) so the CLI has somewhere to run
    // `--resume` from, but that resolved fallback must never be written back
    // into the DB column: doing so silently flips the column from null to
    // the bare project checkout path, which downstream consumers (e.g.
    // StuckSessionMonitor) read as "this session owns a real worktree" and
    // then run git worktree operations directly against the shared project
    // checkout. Real-worktree sessions keep this refresh — re-anchoring
    // worktreePath here is legitimate for them.
    const checkoutOnlyPlanning =
      isPlanningSession(row.session_type) && !usesWorktree(row.session_type);
    if (!checkoutOnlyPlanning) {
      updateSessionWorktreePath(row.session_id, worktreePath);
    }
    return session;
  }

  /**
   * Resume-side counterpart to the dispatch-time branch at
   * completeStart()'s sessionContextContent assembly (~:1950-1979). Branches
   * by session type instead of unconditionally calling buildSessionContext —
   * see the task's write-up for why the unconditional call was a bug:
   * planning sessions (groom/design/ops/split/docs) were having their
   * dispatch-assembled procedure silently replaced by the coding scaffold on
   * every resume (e.g. every backend restart).
   *
   * - planning (isPlanningSession): the procedure was already assembled and
   *   written once at dispatch to the deterministic, sessionId-keyed path
   *   `<projectDir>/.claude/session-prompts/<sessionId>.md` (see
   *   writeSystemPromptFile). That file survives a backend restart same as
   *   the worktree does, so resume reuses it byte-for-byte rather than
   *   rebuilding — there is no in-memory injectedProcedureContent to rebuild
   *   from post-restart, and no DB column persisting it. If the file is
   *   missing, fail loud (mirroring the dispatch-time guard at ~:1966-1979)
   *   rather than silently falling back to the coding scaffold.
   * - review / depth_review: call buildReviewClaudeMd / buildDepthReviewClaudeMd
   *   directly, same as dispatch — cheap, deterministic, no on-disk reuse.
   * - standard: unchanged — build via buildSessionContext and (re)write.
   *
   * Returns undefined when not in CLI mode, when task_url is absent, or when
   * building fails (standard/review/depth_review paths only — the planning
   * path's missing-file case throws instead, see above).
   */
  private async _buildAndWriteResumeSystemPrompt(
    row: Session,
    project: NonNullable<ReturnType<typeof getProjectById>>,
    orchConfig: ReturnType<typeof loadOrchestratorConfig>,
    projectDir: string,
    worktreePath: string,
  ): Promise<string | undefined> {
    if (isPlanningSession(row.session_type)) {
      const existingPath = path.join(
        projectDir,
        '.claude',
        'session-prompts',
        `${row.session_id}.md`,
      );
      if (!fs.existsSync(existingPath)) {
        throw new Error(
          `[SessionManager] planning session (sessionType=${row.session_type}) ` +
            `${row.session_id.slice(0, 8)} has no on-disk system-prompt file at ` +
            `${existingPath} — refusing to fall back to buildSessionContext's ` +
            'coding scaffold on resume',
        );
      }
      logger.info(
        `[SessionManager] reusing existing planning system prompt at ${existingPath} for ${row.session_id.slice(0, 8)}`,
      );
      return existingPath;
    }

    const taskName = row.task_name ?? row.task_url ?? '';
    try {
      if (row.session_type === 'review') {
        const context = buildReviewClaudeMd(
          taskName,
          orchConfig.review_rules.length > 0
            ? orchConfig.review_rules
            : undefined,
        );
        const filePath = writeSystemPromptFile(
          projectDir,
          row.session_id,
          context,
        );
        logger.info(
          `[SessionManager] system prompt written to ${filePath} for ${row.session_id.slice(0, 8)}`,
        );
        return filePath;
      }
      if (row.session_type === 'depth_review') {
        const context = buildDepthReviewClaudeMd(taskName);
        const filePath = writeSystemPromptFile(
          projectDir,
          row.session_id,
          context,
        );
        logger.info(
          `[SessionManager] system prompt written to ${filePath} for ${row.session_id.slice(0, 8)}`,
        );
        return filePath;
      }

      let taskContent: string | undefined;
      if (row.task_id && row.project_id) {
        try {
          taskContent = await getTaskBackend(row.project_id).fetchTaskPage(
            row.task_id,
          );
        } catch {
          // best-effort — build without pre-loaded task content
        }
      }
      const context = buildSessionContext({
        taskName,
        taskUrl: row.task_url ?? '',
        projectContextUrl: row.project_context_url ?? '',
        targetBranch: project.baseBranch ?? 'dev',
        projectDir,
        worktreePath,
        verify: orchConfig.verify.length > 0 ? orchConfig.verify : undefined,
        bashRules:
          orchConfig.bash_rules.length > 0 ? orchConfig.bash_rules : undefined,
        sessionRules:
          orchConfig.session_rules.length > 0
            ? orchConfig.session_rules
            : undefined,
        taskBackend:
          project.taskSource === 'yaml'
            ? 'local'
            : project.taskSource === 'github'
              ? 'github'
              : project.taskSource === 'jira'
                ? 'jira'
                : 'notion',
        taskContent,
        gitMode: project.gitMode,
      });
      const filePath = writeSystemPromptFile(
        projectDir,
        row.session_id,
        context,
      );
      logger.info(
        `[SessionManager] system prompt written to ${filePath} for ${row.session_id.slice(0, 8)}`,
      );
      return filePath;
    } catch (err) {
      logger.warn(
        `[SessionManager] _buildAndWriteResumeSystemPrompt failed for ${row.session_id.slice(0, 8)}: ${err}`,
      );
      return undefined;
    }
  }

  /**
   * A session resume couldn't continue: resumeSession threw, the worktree was
   * missing, or the resumed process re-failed immediately (no events within
   * the resume timeout). Per policy a running/resuming session must never be
   * silently auto-disposed — flag the task needs_attention (resume_failed) so
   * an operator decides, instead of routing through markSessionErrored's
   * crash-budget/Notion-flip path which would silently re-Ready or Block it.
   * The session itself is still driven to a terminal DB status ('error') since
   * its process is gone, but the row is never deleted.
   */
  /**
   * A poke on the sendOrResume/_doSendOrResume live path failed (worktree
   * recreation failed, planning checkout missing). Rather than immediately
   * driving the session terminal on the first failure, count consecutive
   * failures in session_poke_retry_counts and only escalate to
   * flagResumeFailure once POKE_RETRY_LIMIT is reached — a poke/resume
   * failure is often transient (see POKE_RETRY_LIMIT's doc). Below the
   * limit, the session row is left untouched so a later poke can retry;
   * resetSessionPokeRetryCount clears the counter on the next successful
   * poke (see the respawnSession success paths in _doSendOrResume).
   */
  private handlePokeFailure(
    row: Session,
    reason: string,
    detail: string,
  ): void {
    const count = incrementSessionPokeRetryCount(row.session_id);
    // Always broadcast the failure so the UI/operator sees it immediately,
    // whether or not this attempt exhausts the retry budget.
    this.emit('message', {
      type: 'session_action_failed',
      sessionId: row.session_id,
      action: 'sendOrResume',
      reason,
      detail,
    } satisfies ServerMessage);

    if (count < POKE_RETRY_LIMIT) {
      logger.warn(
        `[SessionManager] sendOrResume: poke failed for ${row.session_id.slice(0, 8)} ` +
          `(attempt ${count}/${POKE_RETRY_LIMIT}, reason=${reason}) — ${detail}`,
      );
      return;
    }

    logger.warn(
      `[SessionManager] sendOrResume: poke retry budget exhausted (${count}/${POKE_RETRY_LIMIT}) ` +
        `for ${row.session_id.slice(0, 8)} — routing to flagResumeFailure`,
    );
    this.flagResumeFailure(row, `${reason}: ${detail}`);
  }

  private flagResumeFailure(row: Session, detail: string): void {
    const endedAt = Date.now();

    // Route the terminal status write through the single status deriver
    // (session/sessionStatusDeriver.ts) instead of writing sessions.status
    // directly: record a 'resume_exhausted' completing signal, then let the
    // deriver interpret it. See sessionStatusDeriver's resume_exhausted
    // precedence rule — it applies universally, not per (session_type,
    // task_type, hasOpenPR) triple, so this is safe for every session type
    // flagResumeFailure is called for.
    insertCompletingSignal({
      session_id: row.session_id,
      task_id: row.task_id ?? null,
      session_type: (row.session_type ?? 'standard') as SessionType,
      signal_class: 'resume_exhausted',
      signal_value: 'resume_failed',
      recorded_at: endedAt,
    });
    const derived = deriveSessionStatus({
      sessionId: row.session_id,
      sessionType: (row.session_type ?? 'standard') as SessionType,
      taskTypeCategory: 'any',
      hasOpenPR: false,
      hasNewerSessionForTask: false,
      ledgerEntries: listCompletingSignalsForSession(row.session_id),
    });
    // Always non-null in practice — the resume_exhausted entry just inserted
    // above is guaranteed to match on lookup — but fall back to 'error'
    // defensively rather than throw from within a failure-handling path.
    const status = derived?.status ?? 'error';
    updateSessionStatus(row.session_id, status, endedAt);
    if (derived?.terminalCompletionReason) {
      setSessionTerminalCompletionReason(
        row.session_id,
        derived.terminalCompletionReason,
      );
    }
    try {
      setSessionLastErrorDetail(row.session_id, detail);
    } catch {
      // Best-effort — DB may be unavailable or mocked without this function.
    }

    const liveSession = this.sessions.get(row.session_id);
    if (liveSession) {
      liveSession.hasEnded = true;
    }

    this.emit('message', {
      type: 'session_ended',
      sessionId: row.session_id,
      status,
      ...(row.task_id && { taskId: row.task_id }),
    } satisfies ServerMessage);

    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: row.session_id,
      project_id: null,
      task_id: null,
      payload: {
        sessionId: row.session_id,
        status,
        reason: 'resume_failed',
      },
    });

    if (row.task_id) {
      setTaskPauseReason(row.task_id, 'resume_failed', detail);
      recordEvent({
        event_type: 'auto_launch_paused',
        actor_type: 'system',
        actor_id: row.session_id,
        project_id: row.project_id ?? null,
        task_id: row.task_id,
        payload: { reason: 'resume_failed', sessionId: row.session_id, detail },
      });
    }

    logger.warn(
      `[SessionManager] ${row.session_id.slice(0, 8)} resume failed — flagged needs_attention (resume_failed): ${detail}`,
    );
  }

  /**
   * Re-attach to a session that was running when the server last shut down.
   * Unlike sendOrResume(), this keeps the original session_id so the UI shows
   * continuity — same card, same transcript.
   */
  private async resumeSession(row: Session): Promise<void> {
    // Usage admission gate: don't spawn a resume into an exhausted plan-usage
    // window. Unlike flagResumeFailure this is not a failure — the session
    // row is left exactly as-is (still 'running' in the DB) so a later
    // resumeOrphanSessions pass (next boot, or an operator-triggered retry)
    // picks it back up once the deferral (persisted in usage_deferral)
    // expires. Only tag the task, if any, so it's visible as deferred rather
    // than silently stuck.
    const usageAdmission = isUsageAdmitted();
    if (!usageAdmission.allowed) {
      logger.warn(
        `[SessionManager] resumeSession ${row.session_id}: deferring — plan usage (${usageAdmission.window}) exhausted until ${usageAdmission.deferredUntil ? new Date(usageAdmission.deferredUntil).toISOString() : 'unknown'}`,
      );
      if (row.task_id) {
        setTaskPauseReason(
          row.task_id,
          'usage_limit_deferred',
          usageAdmission.window ?? 'unknown',
        );
      }
      return;
    }

    const project = getProjectById(row.project_id ?? '');
    if (!project) {
      logger.warn(
        `[SessionManager] orphan ${row.session_id}: project not found — cannot resume`,
      );
      this.flagResumeFailure(
        row,
        `project ${row.project_id ?? 'unknown'} not found`,
      );
      return;
    }

    const projectDir = normalizePath(project.projectDir);
    // Planning sessions (groom/design/ops/split) run with cwd === the project
    // checkout and never have a worktree_path — that is their documented shape,
    // not a broken record. Resolve the working directory accordingly instead of
    // treating a null worktree_path as "worktree missing".
    const checkoutOnlyPlanning =
      isPlanningSession(row.session_type) && !usesWorktree(row.session_type);
    const worktreePath = checkoutOnlyPlanning
      ? (row.worktree_path ?? projectDir)
      : (row.worktree_path ?? '');

    // Resumability pre-check: claude --resume requires the original working
    // directory (worktree for standard sessions, project checkout for planning
    // sessions) as cwd. If it's gone (e.g. PR merged and the orchestrator
    // cleaned up the worktree), the spawn would exit immediately and the 30s
    // timeout fallback would fire. Detect this upfront and mark the session as
    // error without spawning anything.
    if (!worktreePath || !fs.existsSync(worktreePath)) {
      const detail = !row.worktree_path
        ? `no path recorded (resolved to ${worktreePath || 'none'})`
        : `path recorded but absent on disk: ${worktreePath}`;
      logger.warn(
        `[SessionManager] resumability pre-check failed for ${row.session_id}: ${detail} — cannot resume`,
      );
      this.flagResumeFailure(row, detail);
      return;
    }

    logger.info(
      `[SessionManager] resumeSession ${row.session_id}: re-using worktree ${worktreePath}`,
    );

    // Load per-project orchestrator config so resumed sessions get the same
    // extra allowed tools (e.g. Bash(dotnet:*)) as freshly spawned ones.
    const orchConfig = loadOrchestratorConfig(projectDir);

    const resumeSessionMode = runtimeSettings.session_mode;
    const resumeRunner =
      resumeSessionMode === 'api'
        ? new ApiSessionRunner(row.session_id)
        : getCorporateMode().gates.dockerMandatory
          ? new DockerSessionRunner(row.session_id)
          : new CliSessionRunner(row.session_id);

    const resumeMcpConfigPath = writeMcpConfig(
      projectDir,
      row.session_id,
      orchConfig.mcp_servers,
      project.taskSource,
    );

    // Re-pin: refresh the system-prompt file outside the worktree so the
    // resumed session is bound to its original task.
    const resumeSystemPromptFilePath =
      resumeSessionMode === 'cli' && row.task_url
        ? await this._buildAndWriteResumeSystemPrompt(
            row,
            project,
            orchConfig,
            projectDir,
            worktreePath,
          )
        : undefined;

    // Shared helper: creates session with original ID, registers, updates DB, emits status.
    const session = this.respawnSession(
      row,
      worktreePath,
      orchConfig,
      resumeRunner,
      resumeMcpConfigPath,
      resumeSystemPromptFilePath,
    );
    // The pre-check above already defers before reaching here in the normal
    // case; this guard only protects against a race where usage exhausts
    // between the two checks — same deferral handling, nothing left to do.
    if (!session) return;

    // Detect mid-turn state: last event was a tool_result or tool_use with no
    // subsequent assistant/result response. Log a warning to aid diagnosis.
    const sessionEvents = getEventsBySession(row.session_id);
    const lastEvent = sessionEvents[sessionEvents.length - 1];
    if (
      lastEvent &&
      (eventKind(lastEvent) === 'tool_result' ||
        eventKind(lastEvent) === 'tool_use')
    ) {
      logger.warn(
        `[SessionManager] resumeSession ${row.session_id}: Resuming mid-turn session — sending continuation nudge`,
      );
    }

    // The CLI in --print --input-format stream-json mode needs stdin input to
    // produce output. Without an upfront message, a resumed session deadlocks:
    // CLI waits for input → SessionManager waits for output → nothing happens.
    // Fix: send the nudge on a short delay after wireSession() (which spawns
    // the CLI process), rather than waiting for a first event that may never
    // arrive. Use this.send() so the nudge is recorded in the DB as a
    // user_message event and broadcast via WebSocket.
    const RESUME_NUDGE_DELAY_MS = 2_000;
    const RESUME_TIMEOUT_MS = 30_000;

    // Error timer: if the CLI doesn't emit any events within 30s, mark as error.
    const errorTimer = setTimeout(() => {
      if (!session.hasEnded) {
        logger.warn(
          `[SessionManager] resumeSession ${row.session_id}: no events within 30s after resume — flagging needs_attention`,
        );
        this.flagResumeFailure(row, 'no events within 30s of resume');
        session.kill().catch(() => {});
      }
    }, RESUME_TIMEOUT_MS);
    errorTimer.unref();

    // Cancel the error timer once the CLI emits its first event.
    session.once('message', () => {
      clearTimeout(errorTimer);
    });

    this.wireSession(row.session_id, session, projectDir, worktreePath);

    // Send the nudge after a short delay so the CLI process is ready to receive
    // stdin before we write to it. Review sessions should not receive the
    // code-session nudge — they wait for a re-review prompt with a diff instead.
    const nudgeMessage = buildResumeMessage(row, 'restart');
    const nudgeDelay = setTimeout(() => {
      if (
        !session.hasEnded &&
        row.session_type !== 'review' &&
        row.session_type !== 'depth_review'
      ) {
        this.send(row.session_id, nudgeMessage);
      }
    }, RESUME_NUDGE_DELAY_MS);
    nudgeDelay.unref();
  }

  /**
   * Kills any process sitting in main/ (the backend's own resting cgroup)
   * with ppid=1 (see reapOrphanedMainCgroupProcesses). Called both from
   * resumeOrphanSessions (boot) and periodically by server.ts's
   * main_cgroup_orphan_sweep Scheduler job — a boot-only sweep cannot
   * bound a process that leaks mid-uptime, which is exactly what produced
   * the incident this method exists to close.
   *
   * Deliberately does NOT call recoverInterruptedTestRequestRuns() here:
   * that function's "every row still 'running' is stale" assumption only
   * holds at boot, when no test run can legitimately be in-flight yet.
   * Mid-uptime, a genuinely in-flight test-lane run's subprocess is (as of
   * this same change) correctly placed under the bounded tests/ cgroup and
   * has its own live proc.on('close') listener in test-runner.ts, which
   * already marks its row failed if that specific subprocess is killed —
   * reaping some unrelated main/ orphan says nothing about that run's own
   * state, so force-failing every running row here would false-fail work
   * that's still genuinely executing and about to produce a real result.
   */
  reapMainCgroupOrphans(): number {
    const reaped = reapOrphanedMainCgroupProcesses();
    if (reaped > 0) {
      logger.info(
        `[SessionManager] reaped ${reaped} orphaned process(es) from main/ cgroup`,
      );
    }
    return reaped;
  }

  /**
   * Detect sessions still marked 'running' in the DB after a server restart
   * and resume them via --resume so they come back to life instead of lingering
   * as unkillable ghosts. Called from server.ts after migrations and imports.
   */
  async resumeOrphanSessions(): Promise<void> {
    // Reap any process left sitting in the backend's own main/ cgroup with
    // ppid=1 — a daemonizing grandchild (e.g. a temp postgres cluster's
    // postmaster) that escaped a prior boot's session placement and is now
    // structurally unreachable by killSessionCgroup, since that only ever
    // touches sessions/<sessionId>/. See sessionCgroup.ts's
    // reapOrphanedMainCgroupProcesses for why ppid=1 is the safe signal.
    // Same sweep also runs periodically post-boot — see reapMainCgroupOrphans.
    this.reapMainCgroupOrphans();

    // Close the loop on deferred done-transitions that were never applied —
    // e.g. the backend restarted between markSessionDone's pending write and
    // applyPendingDoneForSettledSession's own call. Excludes status='running'
    // rows: those are covered below by the ordinary orphan-resume path, and
    // will settle their own pending mark once resumed and their turn ends.
    const unappliedPendingDone = getSessionsWithUnappliedPendingDone();
    for (const row of unappliedPendingDone) {
      if (applyPendingDone(row.session_id)) {
        this.emit('message', {
          type: 'session_status',
          sessionId: row.session_id,
          status: 'done',
        } satisfies ServerMessage);
      }
    }

    // Recover sessions that completed (last event = result) but got stuck at
    // 'running' because the review pipeline threw mid-handleCleanExit.
    const stuckRows = getStuckResultSessionRows();
    if (stuckRows.length > 0) {
      logger.info(
        `[SessionManager] recovering ${stuckRows.length} stuck session(s) from running→done`,
      );
      for (const row of stuckRows) {
        // A planning session's result event can mean "parked, awaiting the
        // operator" rather than "finished" — its last event is a result but
        // its status hasn't made the running→idle transition yet (see
        // AgentSession's clean-exit handling). If it's still holding staged
        // intents nobody has dispositioned, marking it done here would feed
        // sweepStagedIntentsForTerminalSessions a false-terminal status and
        // it would reap a proposal no human has seen. Route it to idle
        // instead and skip the done-path recovery below — a PR-anchored
        // session (standard/review/depth_review) never parks this way, so
        // this carve-out is inert for those.
        if (
          isPlanningSession(row.session_type) &&
          hasUndispositionedStagedIntentsForSession(row.session_id)
        ) {
          markSessionIdle(
            row.session_id,
            row.last_ts,
            row.pr_url ?? null,
            'boot_orphan_result_event_parked_planning',
          );
          continue;
        }
        // Boot-time recovery: no process for this session exists yet this
        // run, so status='running' here reflects a stale write from before
        // the crash/restart, not a turn actually in flight — safe to bypass
        // the in-flight guard.
        markSessionDone(
          row.session_id,
          row.last_ts,
          row.pr_url ?? null,
          'boot_orphan_result_event',
          { skipInFlightGuard: true },
        );
        let taskBackend;
        try {
          taskBackend = row.project_id ? getTaskBackend(row.project_id) : null;
        } catch {
          taskBackend = null;
        }
        if (taskBackend) {
          await recoverSession(row.session_id, {
            scope: 'boot',
            prUrl: row.pr_url ?? undefined,
            prDetectedLive: false,
            sessionType: row.session_type || 'standard',
            taskId: row.task_id || '',
            projectId: row.project_id || '',
            worktreePath: row.worktree_path || '',
            taskUrl: row.task_url || '',
            projectContextUrl: row.project_context_url || '',
            taskBackend,
            sessionManager: this,
            broadcast: (msg) => this.emit('message', msg),
            emitPrOpened: (data) => this.emit('pr_opened', data),
          }).catch((e) =>
            logger.error(
              `[SessionManager] recoverSession failed for ${row.session_id}: ${e}`,
            ),
          );
        }
      }
    }

    // Reap running sessions whose PR is already merged or closed — terminate
    // rather than resume so they don't re-dispatch already-merged work.
    const mergedPrRows = getRunningSessionsWithMergedOrClosedPR();
    if (mergedPrRows.length > 0) {
      logger.info(
        `[SessionManager] reaping ${mergedPrRows.length} session(s) with merged/closed PR`,
      );
      for (const row of mergedPrRows) {
        // Same boot-time reasoning as above — no live process for this
        // session exists yet this run.
        markSessionDone(
          row.session_id,
          row.last_ts,
          row.pr_url ?? null,
          'boot_merged_or_closed_pr',
          { skipInFlightGuard: true },
        );
        let taskBackend;
        try {
          taskBackend = row.project_id ? getTaskBackend(row.project_id) : null;
        } catch {
          taskBackend = null;
        }
        if (taskBackend) {
          await recoverSession(row.session_id, {
            scope: 'boot',
            prUrl: row.pr_url ?? undefined,
            prDetectedLive: false,
            sessionType: row.session_type || 'standard',
            taskId: row.task_id || '',
            projectId: row.project_id || '',
            worktreePath: row.worktree_path || '',
            taskUrl: row.task_url || '',
            projectContextUrl: row.project_context_url || '',
            taskBackend,
            sessionManager: this,
            broadcast: (msg) => this.emit('message', msg),
            emitPrOpened: (data) => this.emit('pr_opened', data),
          }).catch((e) =>
            logger.error(
              `[SessionManager] recoverSession failed for ${row.session_id}: ${e}`,
            ),
          );
        }
      }
    }

    const orphans = getSessionsByStatus(['running']);

    // Reap orphaned Docker containers/networks from sessions no longer
    // active. `status='running'` orphan rows are about to be resumed below
    // and must be excluded here — this.sessions is empty for them this
    // early in boot (they haven't been resumed yet), so without folding
    // their IDs into the live set, the reap call below would treat their
    // still-live containers as orphans and destroy them before the resume
    // loop below ever gets to reattach.
    if (getCorporateMode().gates.dockerMandatory) {
      const liveIds = new Set([
        ...this.sessions.keys(),
        ...orphans.map((row) => row.session_id),
      ]);
      reapOrphanContainers(liveIds);
    }

    if (orphans.length === 0) return;
    logger.info(
      `[SessionManager] found ${orphans.length} orphan session(s) — resuming`,
    );

    const codeSessionCount = [...this.sessions.values()].filter((s) =>
      countsAgainstCodeSessionConcurrency(s.sessionType),
    ).length;
    const available =
      runtimeSettings.max_concurrent_code_sessions - codeSessionCount;
    const reviewOrphans = orphans.filter(
      (row) =>
        row.session_type === 'review' || row.session_type === 'depth_review',
    );
    const codeOrphans = orphans.filter(
      (row) =>
        row.session_type !== 'review' && row.session_type !== 'depth_review',
    );
    const toResume = [...reviewOrphans, ...codeOrphans.slice(0, available)];
    // These orphans were already running before the backend went down — they
    // aren't stuck, there are simply more of them than the *new-dispatch*
    // admission cap (max_concurrent_code_sessions, see start()) allows this
    // boot pass to resume at once. Unlike a genuine resume failure
    // (flagResumeFailure), nothing about them is broken, so don't mark them
    // terminal. Leave their row exactly as-is (still 'running' in the DB) —
    // same deferral shape resumeSession already uses for usage-admission
    // exhaustion — so the next resumeOrphanSessions pass (next boot, or an
    // operator-triggered retry) picks them back up once headroom frees.
    const toDefer = codeOrphans.slice(available);

    for (const row of toResume) {
      try {
        await this.resumeSession(row);
      } catch (err) {
        logger.error(
          `[SessionManager] failed to resume ${row.session_id}: ${err}`,
        );
        // Flag needs_attention rather than silently disposing — an operator
        // decides whether to redispatch (see policy in flagResumeFailure).
        this.flagResumeFailure(
          row,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    for (const row of toDefer) {
      logger.warn(
        `[SessionManager] max concurrent code sessions reached — deferring orphan ${row.session_id}, left resumable for the next resumeOrphanSessions pass`,
      );
    }
  }

  /**
   * Planning sessions (groom/design/ops/split) run with cwd === the project
   * checkout and store worktree_path: null, so cleanupWorktree's own
   * git-status check never runs for them (it returns early via the
   * isRemovableWorktree guard). This is the equivalent check for that
   * teardown path: detection only, never auto-revert or auto-clean — the
   * checkout has legitimately carried deliberate uncommitted hotfixes, and
   * an automatic clean would destroy them.
   */
  private checkPlanningSessionDrift(
    sessionId: string,
    taskId: string,
    projectDir: string,
  ): void {
    let dirty: string;
    try {
      dirty = execSync('git status --porcelain', {
        cwd: projectDir,
        encoding: 'utf8',
      }).trim();
    } catch (err) {
      logger.error(
        `[SessionManager] checkPlanningSessionDrift: git status failed for ${sessionId.slice(0, 8)}: ${err}`,
      );
      return;
    }
    if (!dirty) return;

    const dirtyPaths = dirty.split('\n');
    logger.warn(
      `[SessionManager] planning session ${sessionId.slice(0, 8)} ended with uncommitted changes in ${projectDir}:\n${dirty}`,
    );
    recordEvent({
      event_type: 'planning_session_checkout_drift',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: null,
      task_id: taskId || null,
      payload: {
        sessionId,
        projectDir,
        dirtyPaths,
      },
    });
  }

  private cleanupWorktree(
    sessionId: string,
    worktreePath: string,
    prUrl: string | undefined,
    projectDir: string,
  ): void {
    // Chokepoint guard: never tear down an idle session's worktree, delete
    // its in-memory entry, or revoke its stage credential while its DB
    // status is non-terminal. The worktree IS the session state for idle
    // sessions — uncommitted WIP (code sessions) must survive across
    // idle→resume cycles, and a planning session (worktree_path === the
    // project checkout, pr_url always null) needs its stage credential
    // intact to resume with a working orchestrator MCP connection. Teardown
    // is deferred to terminal events (PR merged/closed, session done/error/
    // killed, explicit delete). This must run first, before any state
    // mutation below — not predicated on pr_url, which planning sessions
    // never have.
    const sessionRow = getSession(sessionId);
    if (sessionRow && !TERMINAL_SESSION_STATUSES.has(sessionRow.status)) {
      return;
    }

    // Kill any surviving process tree rooted in this now-terminal session
    // before doing anything else — a session's CLI process can exit cleanly
    // (session.run() resolving on its own, the natural-completion path into
    // this function) while a Bash-tool-spawned test-command tree it forked
    // (pytest, `uv run task test`) outlives it, since neither endSession()
    // nor kill() — the only other callers of killSessionCgroup — run on
    // that path. cgroup-scoped kill reaches the whole tree regardless of
    // whether any of its processes carry --session-id/--resume, since
    // cgroup-v2 membership is inherited at fork.
    killSessionCgroup(sessionId);

    this.sessions.delete(sessionId);
    revokeStageCredential(sessionId, 'session_teardown');
    revokeRouteCredential(sessionId, 'session_teardown');

    // Guard: never run destructive teardown (git worktree remove / fs.rmSync)
    // on anything but a real per-session worktree — never the project checkout
    // itself (2026-07-20 incident: a planning session's worktreePath ===
    // projectDir caused fs.rmSync to delete a production checkout).
    if (!isRemovableWorktree(worktreePath, projectDir)) {
      const docsTargetSurface =
        sessionRow?.session_type === 'docs'
          ? getSessionDocsTargetSurface(sessionId)
          : undefined;
      const classification = classifyWorktreeTeardownRefusal(
        sessionRow?.session_type || 'standard',
        worktreePath,
        projectDir,
        docsTargetSurface,
      );
      if (classification.expected) {
        logger.debug(
          `[SessionManager] cleanupWorktree: expected worktree-less refusal for ${sessionId.slice(0, 8)} (planning session, no worktree owned)`,
        );
      } else {
        logger.error(
          `[SessionManager] cleanupWorktree refused: worktreePath ${worktreePath} is not a removable worktree under ${projectDir} — skipping teardown for ${sessionId.slice(0, 8)}`,
        );
        recordEvent({
          event_type: 'worktree_teardown_refused',
          actor_type: 'system',
          actor_id: sessionId,
          project_id: null,
          task_id: null,
          payload: {
            sessionId,
            worktreePath,
            projectDir,
            source: 'cleanupWorktree',
            expected: classification.expected,
            reason: classification.reason,
          } satisfies WorktreeTeardownRefusedPayload,
        });
      }
      return;
    }

    // Derive the task branch the session created from the worktree's HEAD.
    let branchName: string | undefined;
    try {
      const head = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: worktreePath,
        encoding: 'utf8',
      }).trim();
      // Only treat it as a task branch if it's not a detached HEAD.
      if (head !== 'HEAD') branchName = head;
    } catch {
      // worktree may already be gone — skip branch deletion
    }

    // Check if the main repo has unexpected modifications after session ends.
    // This catches worktree-escape bugs where a session edited the main repo
    // instead of its assigned worktree.
    try {
      const dirty = execSync('git status --porcelain', {
        cwd: projectDir,
        encoding: 'utf8',
      }).trim();
      if (dirty) {
        logger.warn(
          `[SessionManager] [WARNING] Main repo has uncommitted changes after session ${sessionId.slice(0, 8)} ended — possible worktree escape:\n${dirty}`,
        );
      }
    } catch (err) {
      logger.error(
        `[SessionManager] failed to check main repo status after session ${sessionId.slice(0, 8)}: ${err}`,
      );
    }

    // Remove the per-session MCP config (written under the app data dir,
    // outside the worktree and outside the project checkout — see
    // mcpConfigDir()) before removing the worktree.
    const mcpConfigFile = path.join(mcpConfigDir(), `${sessionId}.mcp.json`);
    try {
      if (fs.existsSync(mcpConfigFile)) {
        fs.unlinkSync(mcpConfigFile);
      }
    } catch (err) {
      logger.warn(
        `[SessionManager] failed to remove per-session MCP config for ${sessionId.slice(0, 8)}: ${err}`,
      );
    }

    // Remove the per-session system-prompt file (written outside the worktree).
    const systemPromptFile = path.join(
      projectDir,
      '.claude',
      'session-prompts',
      `${sessionId}.md`,
    );
    try {
      if (fs.existsSync(systemPromptFile)) {
        fs.unlinkSync(systemPromptFile);
      }
    } catch (err) {
      logger.warn(
        `[SessionManager] failed to remove system-prompt file for ${sessionId.slice(0, 8)}: ${err}`,
      );
    }

    // Backstop for hosts without cgroup-v2 delegation (killSessionCgroup
    // above was a no-op there): kill any process whose command line still
    // names this worktree, keyed on the worktree path rather than
    // --session-id since a test-command tree carries neither flag. Must run
    // before `git worktree remove` — a process still holding the directory
    // open is exactly what turns that command into a retried
    // worktree_remove_failed event.
    killWorktreeProcessTree(worktreePath);

    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: projectDir,
      });
    } catch (err) {
      const stderr =
        (err as { stderr?: string | Buffer })?.stderr?.toString() ??
        String(err);
      logger.error(
        `[SessionManager] failed to remove worktree for ${sessionId}: ${err}`,
      );
      // Fix B: fall back to Node-side fs.rmSync for Windows EINVAL / file-handle errors
      let fallbackOk = false;
      if (fs.existsSync(worktreePath)) {
        try {
          fs.rmSync(worktreePath, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 500,
          });
          fallbackOk = true;
          logger.info(
            `[SessionManager] fs.rmSync fallback succeeded for ${sessionId.slice(0, 8)} after git worktree remove failed`,
          );
        } catch (rmErr) {
          logger.error(
            `[SessionManager] fs.rmSync fallback also failed for ${sessionId.slice(0, 8)}: ${rmErr}`,
          );
        }
      }
      recordEvent({
        event_type: 'worktree_remove_failed',
        actor_type: 'system',
        actor_id: sessionId,
        project_id: null,
        task_id: null,
        payload: { sessionId, worktreePath, stderr, fallbackOk },
      });
    }

    // Fix A: always prune orphan registrations whether remove succeeded or failed
    try {
      execSync('git worktree prune', { cwd: projectDir });
    } catch (pruneErr) {
      logger.warn(
        `[SessionManager] post-cleanup prune failed for ${sessionId.slice(0, 8)}: ${pruneErr}`,
      );
    }

    const deleteBranch = !prUrl || this._mergedSessionIds.has(sessionId);
    this._mergedSessionIds.delete(sessionId);

    if (deleteBranch && branchName) {
      try {
        execSync(`git branch -D "${branchName}"`, {
          cwd: projectDir,
        });
      } catch (err) {
        logger.error(
          `[SessionManager] failed to delete branch ${branchName}: ${err}`,
        );
      }
    }

    // Prune the legacy session/<sessionId> branch created by the pre-refactor dist code.
    pruneSessionBranch(sessionId, projectDir);
  }

  /**
   * Tear down the worktree for a session whose subprocess already exited (idle)
   * and that has now transitioned to a terminal state (done/error via PR merge or
   * PR close). Skips if the worktree path is absent on disk — the chokepoint guard
   * already protected it during the original run().then() cleanup.
   */
  private _teardownIdleSessionWorktree(sessionId: string): void {
    const row = getSession(sessionId);
    if (!row?.worktree_path) return;
    if (!fs.existsSync(row.worktree_path)) return;
    const project = getProjectById(row.project_id ?? '');
    if (!project) return;
    const projectDir = normalizePath(project.projectDir);
    this.cleanupWorktree(
      sessionId,
      row.worktree_path,
      row.pr_url ?? undefined,
      projectDir,
    );
  }

  /** Returns true if the session is currently live in the in-memory sessions map. */
  isAlive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Returns true if an OS process actually exists for this session —
   * independent of (and not to be confused with) isAlive()/the in-memory
   * `this.sessions` map, which can be stale in either direction. See
   * ./processLiveness for the underlying check and ./sessionLivenessReconciler
   * for the sweep that uses this as its liveness signal.
   */
  isProcessAlive(sessionId: string): boolean {
    return isSessionProcessAlive(sessionId);
  }

  /**
   * Count live code sessions (standard/review-adjacent, excludes review and
   * planning types groom/design/ops). Used by AutoLauncher for concurrency —
   * planning sessions compete for the separate shared planning-session pool
   * instead, see start().
   */
  getLiveCodeSessionCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (countsAgainstCodeSessionConcurrency(s.sessionType)) n++;
    }
    for (const [id, p] of this.pendingStarts) {
      if (
        countsAgainstCodeSessionConcurrency(p.sessionType) &&
        !this.sessions.has(id)
      )
        n++;
    }
    return n;
  }

  /**
   * Count live planning sessions (groom/design/ops/split) — the shared pool
   * DispatchTriggerEvaluator's backpressure check reads against, mirroring
   * the same-shaped count start() enforces as the raw cap at launch time.
   *
   * This is a narrower population than the DB-backed
   * queries.countLivePlanningSessions(): it only counts sessions with a live
   * in-memory process (this.sessions/pendingStarts), so an idle session —
   * archived or not — is never counted here, since going idle removes the
   * entry from `this.sessions` (see cleanupWorktree). That is intentional:
   * this counter answers "would spawning one more exceed the concurrency
   * cap right now", not "how much of the pool's capacity is spoken for" —
   * the latter is what the gate reconciler budgets against via
   * countLivePlanningSessions(), which must also count idle-but-resumable
   * sessions as holding a slot. Keep this counter's in-memory-only
   * semantics unchanged when touching either — DispatchTriggerEvaluator
   * depends on it.
   */
  getLivePlanningSessionCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (isPlanningSession(s.sessionType)) n++;
    }
    for (const [id, p] of this.pendingStarts) {
      if (isPlanningSession(p.sessionType) && !this.sessions.has(id)) n++;
    }
    return n;
  }

  /** Returns true if a live session exists for the given task id. */
  hasLiveSessionForTask(taskId: string): boolean {
    return this.findLiveSessionIdForTask(taskId) !== undefined;
  }

  /**
   * Returns the live (non-review, non-planning) session id for the given
   * task id, if any. Skips entries that are ended/terminal — a stalled or
   * already-exited session must not block AutoLauncher from relaunching the
   * task. A genuinely resumable idle session (DB row present, non-terminal
   * status) still counts as live so a parallel launch can't collide with it.
   * Planning sessions (groom/design/ops/split) are excluded: a dispatched
   * groom session that flips its task to Ready parks idle rather than
   * ending, but only a standard/coding session should block a coding
   * launch — a task's status can only flip to Ready at a groom session's
   * end, so a still-running groom can't have flipped it yet, and excluding
   * planning types here is race-safe.
   */
  findLiveSessionIdForTask(taskId: string): string | undefined {
    const norm = taskId.replace(/-/g, '');
    for (const s of this.sessions.values()) {
      if (s.sessionType === 'review' || s.sessionType === 'depth_review')
        continue;
      if (isPlanningSession(s.sessionType)) continue;
      if (s.hasEnded) continue;
      const tid = s.taskId?.replace(/-/g, '');
      if (!tid || tid !== norm) continue;
      const row = getSession(s.sessionId);
      if (row && TERMINAL_STATUSES.has(row.status)) continue;
      return s.sessionId;
    }
    return undefined;
  }

  /**
   * Force-remove a session's in-memory entry, regardless of process lifecycle
   * state. Recovery paths (redispatch, abort, delete) call this to reconcile
   * the live-session map so a stalled or already-exited session can no longer
   * block a relaunch — the normal run().then() cleanup only fires when the
   * subprocess actually exits, which a hung session may never do.
   */
  evictSession(sessionId: string): void {
    this.evictDeadSessionEntry(sessionId);
  }

  /** The live in-memory AgentSession for sessionId, if one is currently running — used by the orchestrator MCP verdict tools to deliver verdicts onto the correct session's emitter. */
  getLiveSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.kill();
      // cleanup (sessions.delete + worktree removal) is driven by run().then()
    }
  }

  /**
   * Durably grant a capability (a Bash command prefix or named MCP write
   * verb — never a category) to a session. Sticky for the session's life,
   * discarded at session end. AgentSession reads the granted set fresh from
   * the DB on every spawn/resume (getSessionAllowedTools), so a grant is
   * always visible to a future respawn even if the server restarts before
   * one happens.
   *
   * That is not enough on its own: a *live* session's --allowed-tools was
   * baked into argv at its last spawn, and the normal mid-session delivery
   * path (sendOrResume's live-session branch) only writes to stdin — it
   * never rebuilds argv. Without forcing a respawn here, a grant to a
   * currently-running session would sit recorded but inert until the
   * process happened to die and get resumed some other way. So: persist
   * first, then — only for a capability that could actually widen
   * --allowed-tools (isGrantable, isToolShapedCapability) and only when the
   * session is currently live — kill and respawn it in place via
   * respawnForCapabilityGrant, reusing the session id and --resume so the
   * transcript and staged intents survive.
   *
   * The returned `respawnApplied` reflects whether that respawn actually
   * took effect — false whenever it was never attempted (capability not
   * grantable/tool-shaped, or the session isn't live) or attempted and
   * declined by respawnForCapabilityGrant's own exits (worktree missing,
   * usage-admission deferred). This is an operator/diagnostic signal, not
   * something to relay to the requesting session: the grant is persisted
   * either way, non-tool-shaped capabilities (the common case) are checked
   * directly against the granted set with no respawn ever involved, and a
   * session has no way to act on "wait for a respawn" — a caller composing
   * a message back to the session must use the same wording regardless of
   * `respawnApplied`, and should route a false value to operator-facing
   * logs/surfaces instead (respawnForCapabilityGrant already logs its own
   * decline reasons).
   */
  async grantCapability(
    sessionId: string,
    capability: string,
  ): Promise<{ granted: string[]; respawnApplied: boolean }> {
    const granted = addGrantedCapability(sessionId, capability);
    let respawnApplied = false;

    if (
      isGrantable(capability) &&
      isToolShapedCapability(capability) &&
      this.sessions.has(sessionId)
    ) {
      try {
        respawnApplied = await this.respawnForCapabilityGrant(sessionId);
      } catch (err) {
        logger.error(
          `[SessionManager] grantCapability: respawn failed for ${sessionId.slice(0, 8)}: ${err}`,
        );
      }
    }

    return { granted, respawnApplied };
  }

  /**
   * Durably revoke a capability from a session's granted set. Mirrors
   * grantCapability's live-session handling, but in the opposite safety
   * direction: a delayed grant just denies a tool call (fail-closed), while
   * a delayed revoke leaves an already-a-concern capability exercisable in
   * a live process (fail-open) — so a tool-shaped capability
   * (isGrantable/isToolShapedCapability) revoked from a currently-live
   * session forces an immediate kill+respawn via respawnForCapabilityGrant,
   * same mechanism as the grant path, so it actually leaves the live
   * process's argv rather than sitting revoked-in-DB-but-still-usable.
   */
  async revokeCapability(
    sessionId: string,
    capability: string,
  ): Promise<string[]> {
    const granted = removeGrantedCapability(sessionId, capability);

    if (
      isGrantable(capability) &&
      isToolShapedCapability(capability) &&
      this.sessions.has(sessionId)
    ) {
      try {
        await this.respawnForCapabilityGrant(sessionId);
      } catch (err) {
        logger.error(
          `[SessionManager] revokeCapability: respawn failed for ${sessionId.slice(0, 8)}: ${err}`,
        );
      }
    }

    return granted;
  }

  /**
   * Kill (if live) and respawn a session in place so a just-persisted
   * capability grant takes effect: AgentSession.run() recomputes
   * --allowed-tools from the DB's granted set on every spawn (see
   * AgentSession.ts's getSessionAllowedTools call), so a fresh spawn is
   * what actually delivers the grant. Reuses the session's existing
   * worktree and session id with --resume, mirroring the fast path in
   * _doSendOrResume, so conversation history and staged intents survive.
   * Returns false without killing anything if the worktree can't be found —
   * in that case the grant still lands on whatever later resume path
   * (sendOrResume, resumeSession) eventually revives the session.
   */
  /** See ISessionManager.recordInSessionOverloadEvent. */
  recordInSessionOverloadEvent(sessionId: string): {
    count: number;
    escalated: boolean;
    cooldownMs: number;
  } {
    return this.inSessionOverloadBudget.recordEvent(sessionId);
  }

  /** See ISessionManager.clearInSessionOverloadBudget. */
  clearInSessionOverloadBudget(sessionId: string): void {
    this.inSessionOverloadBudget.clear(sessionId);
  }

  /**
   * See ISessionManager.respawnForTransientOverload. Reuses the same
   * kill+respawn-with-worktree logic as respawnForCapabilityGrant — the
   * mechanics (kill live process, reopen with --resume against the same
   * worktree/session id) are identical; only the trigger differs.
   */
  async respawnForTransientOverload(sessionId: string): Promise<boolean> {
    return this.respawnForCapabilityGrant(sessionId);
  }

  private async respawnForCapabilityGrant(sessionId: string): Promise<boolean> {
    const row = getSession(sessionId);
    if (!row) return false;

    const project = getProjectById(row.project_id ?? '');
    if (!project) return false;
    const projectDir = normalizePath(project.projectDir);
    const defaultWorktreePath = path.join(
      projectDir,
      '.claude',
      'worktrees',
      sessionId,
    );
    const recordedPath =
      isPlanningSession(row.session_type) && !usesWorktree(row.session_type)
        ? (row.worktree_path ?? projectDir)
        : (row.worktree_path ?? defaultWorktreePath);

    if (
      !recordedPath ||
      !fs.existsSync(recordedPath) ||
      !fs.existsSync(path.join(recordedPath, '.git'))
    ) {
      logger.warn(
        `[SessionManager] respawnForCapabilityGrant: worktree missing for ${sessionId.slice(0, 8)} — grant will take effect on next resume instead`,
      );
      return false;
    }

    // This kill is not a real death — the same session id is about to come
    // back with --resume, so its staged intents must survive it. Suppress
    // the reap for this single call only; if respawnSession below fails, the
    // failure branch reaps explicitly instead (see comment there).
    const liveSession = this.sessions.get(sessionId);
    if (liveSession) {
      await liveSession.kill({ suppressReap: true });
    }
    this.evictDeadSessionEntry(sessionId);

    const orchConfig = loadOrchestratorConfig(projectDir);
    const mode = runtimeSettings.session_mode;
    const runner =
      mode === 'api'
        ? new ApiSessionRunner(sessionId)
        : getCorporateMode().gates.dockerMandatory
          ? new DockerSessionRunner(sessionId)
          : new CliSessionRunner(sessionId);
    const mcpConfigPath = writeMcpConfig(
      projectDir,
      sessionId,
      orchConfig.mcp_servers,
      project.taskSource,
    );
    const systemPromptFilePath =
      mode === 'cli' && row.task_url
        ? await this._buildAndWriteResumeSystemPrompt(
            row,
            project,
            orchConfig,
            projectDir,
            recordedPath,
          )
        : undefined;

    const session = this.respawnSession(
      row,
      recordedPath,
      orchConfig,
      runner,
      mcpConfigPath,
      systemPromptFilePath,
    );
    if (!session) {
      // The live session (if any) was already killed above with the reap
      // suppressed, or there was no live session to kill. Either way, no
      // replacement session gets created here, so the grant respawn has
      // definitively not happened and the session is genuinely down now.
      // This session already existed before the failed respawn, so it may
      // already carry staged intents — reapStagedIntentsForNeverStagedSession
      // only reaps it if it never staged anything at all; a session with
      // real findings is left untouched here and picked up on its next
      // resume instead. Deferred admission means nothing gets respawned in
      // its place right now — the grant takes effect on the next resume
      // (resumeOrphanSessions on this row once the deferral clears) instead.
      logger.warn(
        `[SessionManager] respawnForCapabilityGrant: usage-admission deferred for ${sessionId.slice(0, 8)} — grant will take effect on next resume instead`,
      );
      try {
        reapStagedIntentsForNeverStagedSession(
          sessionId,
          'session_killed_no_artifact',
          Date.now(),
        );
      } catch {
        // Best-effort — DB may be unavailable or mocked without this function.
      }
      return false;
    }
    this.wireSession(sessionId, session, projectDir, recordedPath);
    return true;
  }

  /**
   * In-place respawn for a session detected as MCP-unreachable by
   * reconcileMcpUnreachableSessions below. Same suppress-reap /
   * same-session-id / --resume mechanism as respawnForCapabilityGrant just
   * above — kills the live process (if any) with the reap suppressed so
   * staged intents survive, then respawns under the same session id with
   * --resume, giving the CLI a fresh MCP client that re-attempts every
   * configured server. A resumed CLI process reuses its already-failed MCP
   * client, so only a genuinely fresh process (this respawn) can recover
   * the connection — poking or re-prompting the same process cannot.
   *
   * Declines cleanly (returns false, no event, no error) when the
   * session's worktree is missing, mirroring respawnForCapabilityGrant's
   * own guard — there is nothing to resume onto.
   */
  private async respawnForMcpUnreachable(
    sessionId: string,
    attemptNumber: number,
  ): Promise<boolean> {
    const row = getSession(sessionId);
    if (!row) return false;

    const project = getProjectById(row.project_id ?? '');
    if (!project) return false;
    const projectDir = normalizePath(project.projectDir);
    const defaultWorktreePath = path.join(
      projectDir,
      '.claude',
      'worktrees',
      sessionId,
    );
    const recordedPath =
      isPlanningSession(row.session_type) && !usesWorktree(row.session_type)
        ? (row.worktree_path ?? projectDir)
        : (row.worktree_path ?? defaultWorktreePath);

    if (
      !recordedPath ||
      !fs.existsSync(recordedPath) ||
      !fs.existsSync(path.join(recordedPath, '.git'))
    ) {
      logger.warn(
        `[SessionManager] respawnForMcpUnreachable: worktree missing for ${sessionId.slice(0, 8)} — declining respawn`,
      );
      return false;
    }

    // This kill is not a real death — see respawnForCapabilityGrant's
    // identical comment above.
    const liveSession = this.sessions.get(sessionId);
    if (liveSession) {
      await liveSession.kill({ suppressReap: true });
    }
    this.evictDeadSessionEntry(sessionId);

    const orchConfig = loadOrchestratorConfig(projectDir);
    const mode = runtimeSettings.session_mode;
    const runner =
      mode === 'api'
        ? new ApiSessionRunner(sessionId)
        : getCorporateMode().gates.dockerMandatory
          ? new DockerSessionRunner(sessionId)
          : new CliSessionRunner(sessionId);
    const mcpConfigPath = writeMcpConfig(
      projectDir,
      sessionId,
      orchConfig.mcp_servers,
      project.taskSource,
    );
    const systemPromptFilePath =
      mode === 'cli' && row.task_url
        ? await this._buildAndWriteResumeSystemPrompt(
            row,
            project,
            orchConfig,
            projectDir,
            recordedPath,
          )
        : undefined;

    const session = this.respawnSession(
      row,
      recordedPath,
      orchConfig,
      runner,
      mcpConfigPath,
      systemPromptFilePath,
    );
    if (!session) {
      logger.warn(
        `[SessionManager] respawnForMcpUnreachable: respawnSession deferred/failed for ${sessionId.slice(0, 8)}`,
      );
      try {
        reapStagedIntentsForNeverStagedSession(
          sessionId,
          'session_killed_no_artifact',
          Date.now(),
        );
      } catch {
        // Best-effort — DB may be unavailable or mocked without this function.
      }
      return false;
    }
    this.wireSession(sessionId, session, projectDir, recordedPath);

    recordEvent({
      event_type: 'session_mcp_unreachable_respawned',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: row.project_id ?? null,
      task_id: row.task_id ?? null,
      payload: { session_id: sessionId, attempt_number: attemptNumber },
    });

    return true;
  }

  /**
   * Detects a live session whose orchestrator MCP server never connected —
   * the CLI-side stall documented on this task: --strict-mcp-config plus a
   * valid stage credential still leaves the CLI's own MCP client
   * unconnected in some observed cases, and a resumed CLI process reuses
   * its already-failed MCP client, so no amount of poking or re-prompting
   * recovers it. Only a fresh CLI process re-attempts every configured MCP
   * server, so this recovers via respawnForMcpUnreachable's bounded
   * in-place respawn — never by terminating the session, which would
   * return its task to the dispatch pool and risk the exact thrash loop
   * observed elsewhere (a session dies, the orphan sweeper reverts its task
   * to Ready, a fresh session launches, repeat).
   *
   * Candidate population: every live (non-terminal) session. Skipped
   * entirely in api session_mode, mirroring the other liveness
   * reconcilers' skip — an ApiSessionRunner session has no CLI subprocess
   * and no MCP client to fail.
   *
   * Grace window: no detection fires until MCP_UNREACHABLE_GRACE_MS has
   * elapsed since the session's most recent spawn — its original
   * started_at, or its latest respawn attempt's timestamp once this
   * reconciler has already respawned it once (getLatestMcpUnreachableRespawnTimestamp).
   * That reference moves forward on every respawn, so the grace window
   * restarts each time: a session that reconnects cleanly on its new
   * process is never flagged again (hasMcpConnectionEstablishedSince finds
   * a fresh event), and one that doesn't gets re-detected once the next
   * window elapses, up to MAX_MCP_UNREACHABLE_RESPAWNS.
   */
  async reconcileMcpUnreachableSessions(): Promise<{
    detected: string[];
    respawned: string[];
    exhausted: string[];
  }> {
    const detected: string[] = [];
    const respawned: string[] = [];
    const exhausted: string[] = [];

    if (runtimeSettings.session_mode === 'api') {
      return { detected, respawned, exhausted };
    }

    const now = Date.now();
    for (const row of listLiveSessionRows()) {
      if (hasMcpUnreachableExhaustedEvent(row.session_id)) continue;

      const lastSpawnMs =
        getLatestMcpUnreachableRespawnTimestamp(row.session_id) ??
        row.started_at;
      const hasConnectedSinceSpawn = hasMcpConnectionEstablishedSince(
        row.session_id,
        lastSpawnMs,
      );

      if (
        !isMcpUnreachable({
          hasConnectedSinceSpawn,
          nowMs: now,
          lastSpawnMs,
          graceMs: MCP_UNREACHABLE_GRACE_MS,
        })
      ) {
        continue;
      }

      const attemptsSoFar = countMcpUnreachableRespawnAttempts(row.session_id);
      const attemptNumber = attemptsSoFar + 1;

      recordEvent({
        event_type: 'session_mcp_unreachable_detected',
        actor_type: 'system',
        actor_id: row.session_id,
        project_id: row.project_id ?? null,
        task_id: row.task_id ?? null,
        payload: {
          session_id: row.session_id,
          attempt_number: attemptNumber,
        },
      });
      detected.push(row.session_id);

      if (attemptsSoFar >= MAX_MCP_UNREACHABLE_RESPAWNS) {
        setSessionPauseReason(row.session_id, 'mcp_unreachable_exhausted');
        recordEvent({
          event_type: 'session_mcp_unreachable_respawn_exhausted',
          actor_type: 'system',
          actor_id: row.session_id,
          project_id: row.project_id ?? null,
          task_id: row.task_id ?? null,
          payload: {
            session_id: row.session_id,
            attempt_number: attemptNumber,
            max_respawns: MAX_MCP_UNREACHABLE_RESPAWNS,
          },
        });
        exhausted.push(row.session_id);
        logger.warn(
          `[SessionManager] reconcileMcpUnreachableSessions: session ${row.session_id.slice(0, 8)} exhausted ${MAX_MCP_UNREACHABLE_RESPAWNS} MCP-unreachable respawn attempts — surfaced to operator`,
        );
        continue;
      }

      try {
        const ok = await this.respawnForMcpUnreachable(
          row.session_id,
          attemptNumber,
        );
        if (ok) respawned.push(row.session_id);
      } catch (err) {
        logger.error(
          `[SessionManager] reconcileMcpUnreachableSessions: respawn failed for ${row.session_id.slice(0, 8)}: ${err}`,
        );
      }
    }

    return { detected, respawned, exhausted };
  }

  /**
   * Abort a session: kill the process, pre-mark the DB as killed (so orphan-resume
   * cannot re-attach on server restart), and reset the task to Ready.
   *
   * Distinct from kill(): abort always resets the task to Ready and pre-marks the
   * session killed in the DB before sending the kill signal, ensuring the session
   * can never be resumed even if the server crashes mid-abort.
   */
  async abortSession(sessionId: string): Promise<void> {
    const endedAt = Date.now();
    const row = getSession(sessionId);
    if (!row) return;

    // Pre-mark as killed immediately — prevents orphan-resume on server restart.
    updateSessionStatus(sessionId, 'killed', endedAt);
    setSessionTerminalCompletionReason(sessionId, 'operator_abort');

    // abortSession bypasses markSessionErrored, so it needs its own call —
    // see that method for why this only ever reaps a session that never
    // staged anything of its own; a genuinely operator-abandoned finding
    // stays on the decision surface for the operator to disposition.
    try {
      reapStagedIntentsForNeverStagedSession(
        sessionId,
        'session_killed_no_artifact',
        endedAt,
      );
    } catch {
      // Best-effort — DB may be unavailable or mocked without this function.
    }

    // Set hasEnded on the in-memory session to prevent markSessionErrored from
    // double-updating DB and task status when kill() fires.
    const liveSession = this.sessions.get(sessionId);
    if (liveSession) liveSession.hasEnded = true;

    // Broadcast session_ended so the frontend updates the session card immediately.
    this.emit('message', {
      type: 'session_ended',
      sessionId,
      status: 'killed',
      ...(row.task_id && { taskId: row.task_id }),
    } satisfies ServerMessage);

    // Record audit event.
    recordEvent({
      event_type: 'session_aborted',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: row.project_id ?? null,
      task_id: row.task_id ?? null,
      payload: { sessionId, reason: 'user_abort' },
    });

    // Kill the process (fire-and-forget — cleanup via run().then() still fires
    // for a genuinely live process, but is a no-op / never fires for a session
    // that has already exited or hung, so we also evict directly below).
    if (liveSession) {
      liveSession.kill().catch((err) => {
        logger.error(
          `[SessionManager] abortSession kill error for ${sessionId.slice(0, 8)}: ${err}`,
        );
      });
    }

    // Evict the in-memory entry now rather than relying solely on the
    // run().then() cleanup cascade, which never fires for an already-exited
    // or hung session — leaving a dead map entry that blocks relaunch.
    this.evictSession(sessionId);

    // Reset the task to Ready so the next launch is a fresh session. Also
    // applies to ops sessions — an ops launch mechanically moved the task to
    // In Progress (movesTargetInProgress), and an abort without a resolving
    // disposition must not strand it there.
    if (
      (row.session_type !== 'standard' && row.session_type !== 'ops') ||
      !row.task_id
    )
      return;
    const notionTaskId = row.task_id;
    const projectId = row.project_id ?? '';

    getTaskBackend(projectId)
      .updateStatus(notionTaskId, '🗂️ Ready', {
        source: 'orchestrator',
        sessionId,
      })
      .then(() => {
        this.emit('message', {
          type: 'task_status_changed',
          notionTaskId,
          newStatus: '🗂️ Ready',
        } satisfies ServerMessage);
        emitTaskUpdated(notionTaskId);
      })
      .catch((e) =>
        logger.error(`[SessionManager] abortSession updateStatus failed: ${e}`),
      );
  }

  /**
   * Reclaim a session whose stage or route credential was presented after
   * being revoked — see setRevokedStageCredentialHandler/
   * setRevokedRouteCredentialHandler wiring in the constructor above. A
   * session cannot request or refresh a new credential once its own is
   * revoked, so if its process is still calling in with the old one,
   * leaving it running only buys it an infinite retry/backoff loop against
   * a server that will never accept it again. Per the operator ruling,
   * that is grounds to reclaim its OS process and drain it from the live
   * population — never grounds for this machine path to write a terminal
   * status itself; terminalizing a session is an operator action only.
   *
   * Safe to call for a row that's already terminal or already archived
   * (idempotent — a credential can be revoked well after its session
   * concluded some other way).
   */
  private terminateSessionForRevokedCredential(
    sessionId: string,
    surface: 'mcp' | 'route',
  ): void {
    const row = getSession(sessionId);
    const reason = `credential_revoked_${surface}`;
    archiveSession(sessionId);
    setSessionPauseReason(sessionId, reason);

    recordEvent({
      event_type: 'session_surfaced_to_operator',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: row?.project_id ?? null,
      task_id: row?.task_id ?? null,
      payload: { sessionId, surface, reason },
    });

    const liveSession = this.sessions.get(sessionId);
    if (liveSession) {
      Promise.resolve(liveSession.reclaimProcess()).catch((err) => {
        logger.error(
          `[SessionManager] terminateSessionForRevokedCredential reclaim error for ${sessionId.slice(0, 8)}: ${err}`,
        );
      });
    }
    this.evictSession(sessionId);
    logger.warn(
      `[SessionManager] session ${sessionId.slice(0, 8)} presented a revoked ${surface} credential — reclaimed and surfaced to operator`,
    );
  }

  /**
   * Close stdin on the session process so the CLI can exit cleanly, then
   * verify it actually did and escalate to a forceful kill if not.
   *
   * Callers must only invoke this once a session's row has genuinely
   * reached a terminal status (done / error / killed) — idle is never
   * terminal (a session parked awaiting an operator disposition is
   * legitimately alive with a live process), so a non-terminal row here is
   * refused rather than risking a kill of a live session.
   */
  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const row = getSession(sessionId);
      if (row && !TERMINAL_SESSION_STATUSES.has(row.status)) {
        logger.warn(
          `[SessionManager] endSession called for non-terminal session ${sessionId.slice(0, 8)} (status=${row.status}) — refusing to escalate against a live session`,
        );
        return;
      }
      Promise.resolve(session.endSession()).catch((err) => {
        logger.error(
          `[SessionManager] endSession escalation failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`,
        );
      });
      return;
    }
    // Absent from the in-memory map does not mean the process exited — it
    // means either a cross-restart orphan (a different backend process;
    // out of scope here, recovered by resumeOrphanSessions/manual sweep)
    // or a stale reference dropped by reconcileSessionsMap, which now
    // reaps the process before ever evicting the entry. Either way there
    // is no live handle left in this process to escalate the process
    // itself against, so only the worktree is finalized. The session's
    // cgroup is keyed by sessionId alone (no live handle required), so it
    // is torn down here regardless — this is the only path that reaps a
    // daemonized grandchild left behind when a prior CliSessionRunner
    // instance (and its in-memory session) is already gone.
    this._teardownIdleSessionWorktree(sessionId);
    killSessionCgroup(sessionId);
  }

  /**
   * Reclaim a parked session's OS process without terminating the session.
   * Unlike endSession(), this is not gated on the row already being
   * terminal — it exists precisely for a session that must stay idle (see
   * StuckSessionMonitor.escalateStuckAliveSubprocessPark, which reclaims a
   * subprocess still alive long after its session parked, to relieve
   * AutoLauncher's memory admission gate, without destroying a session
   * that may have already finished its work). Frees the OS process via the
   * same graceful-close-then-verify-and-escalate teardown as endSession()
   * (emitting session_teardown_escalated on the same terms), but never
   * touches DB status — the row is left exactly as it was for the existing
   * resume machinery (sendOrResume/resumeSession) to reattach.
   */
  reclaimSessionProcess(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      Promise.resolve(session.reclaimProcess()).catch((err) => {
        logger.error(
          `[SessionManager] reclaimSessionProcess failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`,
        );
      });
      return;
    }
    // No live in-memory handle for this backend process (cross-restart
    // orphan, or a stale reference already reaped elsewhere) — nothing to
    // escalate against here. Reap via cgroup only; the row's worktree must
    // not be touched since it stays idle, not terminal.
    killSessionCgroup(sessionId);
  }

  /**
   * Archive a session's row and reap any live subprocess so it doesn't keep
   * holding a concurrency slot under an archived (dashboard-invisible) row.
   * Shared by the archive route and any terminal-status writer so the two
   * paths can't drift apart again. Relies on endSession()'s verify-and-
   * escalate teardown to actually make the "no live subprocess" guarantee
   * true rather than just closing stdin and hoping.
   */
  archiveAndEndSession(sessionId: string): void {
    archiveSession(sessionId);
    this.endSession(sessionId);
  }

  /** Mark a session so cleanupWorktree deletes its local branch (used on PR merge). */
  markForBranchDeletion(sessionId: string): void {
    this._mergedSessionIds.add(sessionId);
  }

  approve(sessionId: string): void {
    this.sessions.get(sessionId)?.approve();
  }

  deny(sessionId: string, reason?: string): void {
    this.sessions.get(sessionId)?.deny(reason);
  }

  /**
   * Register a Promise that resolves when the post-revert worktree sync completes.
   * Emits a 'revert_sync_registered' event so ReviewOrchestrator can await it
   * before fetching the PR diff for a re-review.
   */
  registerRevertSync(
    prNumber: number,
    repo: string,
    syncPromise: Promise<void>,
  ): void {
    this.emit('revert_sync_registered', { prNumber, repo, syncPromise });
  }

  /**
   * Add files to the per-session one-cycle injection skip lock.
   * Called by the autofix path so that files committed by autofix are not
   * immediately re-injected by the orchestrator context writer.
   */
  addToRevertLock(sessionId: string, files: string[]): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      for (const f of files) {
        session.lockFileForNextInjection(f);
      }
    }
  }

  /**
   * Send a follow-up user message to a running session via stdin.
   *
   * @returns true if the write was confirmed to reach the session's
   * underlying process. The session_events row and WS broadcast are only
   * recorded on a confirmed send — otherwise the frontend transcript and
   * inbox delivered-flag would show a message as delivered when the
   * subprocess never actually received it (see sendOrResume/
   * deliverUndeliveredInboxItems, which fall back to a --resume respawn on
   * a false return instead of treating this as success).
   */
  send(sessionId: string, message: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const delivered = session.sendMessage(message);
    if (!delivered) return false;
    const ts = Date.now();
    insertEvent({
      session_id: sessionId,
      event_type: 'user_message',
      payload: message,
      timestamp: ts,
    });
    this.emit('message', {
      type: 'session_event',
      sessionId,
      eventType: 'user_message',
      content: message,
    } satisfies ServerMessage);
    return true;
  }

  /**
   * Enqueue a feedback item to a session's inbox instead of writing to stdin
   * directly. A live session that is mid-turn picks the item up at its next
   * turn boundary via AgentSession.deliverInboxItems() — no further action is
   * taken here, so an in-flight turn is never interleaved with feedback. A
   * live session that is idle (registered in `this.sessions` but with no turn
   * in flight) would otherwise never reach another boundary, so it is woken
   * immediately via the same delivery path used for idle/exited sessions
   * (sendOrResume — a direct send() for a live session, a clean respawn
   * otherwise), never a raw stdin write into a possibly mid-teardown process.
   * Terminal sessions (done/error/killed) default to a resume attempt
   * (bypassing the normal terminal refusal, mirroring relaunchFixerForPR's
   * recovery path); only if that resume attempt itself fails is the item
   * marked delivered-without-resend, and even then a needs-attention signal
   * is surfaced (pause reason + session_action_failed) instead of dropping
   * it silently. Callers that pass `{ attemptTerminalResume: false }` (the
   * staged-intent disposition routes) opt out of all of that: on a terminal
   * session the item is simply marked delivered, with no resume, no pause
   * reason, and no needs-attention signal — a terminal session not
   * receiving a disposition is the expected outcome there, not a failure.
   * reconcileInboxAtBoot/redeliverUndeliveredFeedback do not opt into
   * terminal resume either — a boot sweep across every terminal session
   * with stale items should not mass-relaunch them.
   */
  /**
   * Parks a session awaiting an operator decision, carrying the question it
   * asked — the generalized sibling of a session.requestCapability staged
   * intent (see isSessionAwaitingOperatorDecision). Recorded to the audit
   * log so the question is visible on the operator-facing surfaces that
   * already read audit_log, not only retrievable by direct DB query.
   */
  askOperatorQuestion(sessionId: string, question: string): void {
    const askedAt = Date.now();
    setSessionAwaitingOperatorDecision(sessionId, question, askedAt);
    const session = getSession(sessionId);
    recordEvent({
      event_type: 'session_awaiting_operator_decision',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: session?.project_id ?? null,
      task_id: session?.task_id ?? null,
      payload: { sessionId, question, askedAt },
    });
  }

  /**
   * Discharges a session's awaiting-operator-decision state and delivers
   * the operator's answer as ordinary feedback via the existing
   * enqueueFeedback path — the counterpart to askOperatorQuestion above.
   * Clears the marker before enqueueing so a concurrently-running
   * OrphanedTaskSweeper/StalledPRReconciler sweep can never observe the
   * question as still pending once the answer has been recorded.
   */
  async answerOperatorQuestion(
    sessionId: string,
    answer: string,
  ): Promise<void> {
    const pending = getSessionOperatorQuestion(sessionId);
    clearSessionAwaitingOperatorDecision(sessionId);
    const session = getSession(sessionId);
    recordEvent({
      event_type: 'session_operator_decision_answered',
      actor_type: 'human',
      actor_id: sessionId,
      project_id: session?.project_id ?? null,
      task_id: session?.task_id ?? null,
      payload: { sessionId, question: pending?.question ?? null, answer },
    });
    await this.enqueueFeedback(sessionId, 'operator:answer', answer);
  }

  async enqueueFeedback(
    sessionId: string,
    source: string,
    payload: string,
    opts: { attemptTerminalResume?: boolean } = {},
  ): Promise<void> {
    enqueueFeedbackItem(sessionId, source, payload);

    // Live, mid-turn session — the next turn boundary (deliverInboxItems) will deliver it.
    const liveSession = this.sessions.get(sessionId);
    if (liveSession && liveSession.hasActiveTurn()) return;

    await this.deliverUndeliveredInboxItems(sessionId, 'enqueueFeedback', {
      attemptTerminalResume: opts.attemptTerminalResume ?? true,
    });
  }

  /**
   * Deliver all currently-undelivered inbox items for a session right now.
   * Shared by enqueueFeedback (live-but-idle / respawn case) and
   * reconcileInboxAtBoot so the two never diverge:
   *  - terminal sessions (done/error/killed): by default marked delivered
   *    without resending. When `attemptTerminalResume` is set (enqueueFeedback
   *    only), a resume is attempted first via sendOrResume({allowTerminal}) —
   *    on failure, a needs-attention signal is surfaced instead of a silent drop.
   *  - otherwise: coalesce undelivered items into one message and deliver via
   *    sendOrResume (direct send() for a live session, a clean --resume
   *    respawn otherwise), then mark delivered only after a successful send.
   */
  private async deliverUndeliveredInboxItems(
    sessionId: string,
    logContext: string,
    opts: { attemptTerminalResume?: boolean } = {},
  ): Promise<void> {
    const row = getSession(sessionId);
    if (!row) return;

    const isDoneErrorKilled =
      row.status === 'done' ||
      row.status === 'error' ||
      row.status === 'killed';
    // archived=1 is an explicit operator signal the session is done (see
    // archiveAndEndSession) — unlike done/error/killed, it is never eligible
    // for the attemptTerminalResume resend path below, even when the caller
    // (e.g. enqueueFeedback informing a session of a disposition) asks for it.
    const isArchived = row.archived === 1;
    const isTerminal = isDoneErrorKilled || isArchived;

    const items = listUndeliveredInboxItems(sessionId);
    if (items.length === 0) return;
    const combined = items
      .map((item) => `[${item.source}]\n${item.payload}`)
      .join('\n\n');

    if (isTerminal && (isArchived || !opts.attemptTerminalResume)) {
      markInboxItemsDelivered(items.map((i) => i.id));
      return;
    }

    this.emitFeedbackPending(sessionId, true);

    if (isTerminal) {
      let resumed: string | null = null;
      try {
        resumed = await this.sendOrResume(sessionId, combined, {
          allowTerminal: true,
          persistTextOnDefer: false,
        });
      } catch (err) {
        logger.warn(
          `[SessionManager] ${logContext}: resume of terminal session ${sessionId.slice(0, 8)} failed: ${err}`,
        );
      }
      if (!resumed) {
        setSessionPauseReason(sessionId, 'feedback_undelivered_terminal');
        this.emit('message', {
          type: 'session_action_failed',
          sessionId,
          action: 'enqueue_feedback',
          reason: 'terminal_session_unresumable',
          detail:
            'Session ended and could not be resumed to deliver pending feedback — needs operator attention.',
        } satisfies ServerMessage);
      }
      markInboxItemsDelivered(items.map((i) => i.id));
      this.emitFeedbackPending(sessionId, false);
      return;
    }

    let delivered: string | null;
    try {
      delivered = await this.sendOrResume(sessionId, combined, {
        persistTextOnDefer: false,
      });
    } catch (err) {
      logger.warn(
        `[SessionManager] ${logContext}: sendOrResume failed for ${sessionId.slice(0, 8)}: ${err}`,
      );
      recordEvent({
        event_type: 'verdict_routing_failed',
        actor_type: 'system',
        actor_id: sessionId,
        project_id: row.project_id ?? null,
        task_id: row.task_id ?? null,
        payload: {
          session_id: sessionId,
          log_context: logContext,
          error: String(err),
        },
      });
      this.emitFeedbackPending(sessionId, false);
      return;
    }
    if (!delivered) {
      logger.warn(
        `[SessionManager] ${logContext}: sendOrResume could not deliver to ${sessionId.slice(0, 8)} — leaving item(s) undelivered`,
      );
      recordEvent({
        event_type: 'verdict_routing_failed',
        actor_type: 'system',
        actor_id: sessionId,
        project_id: row.project_id ?? null,
        task_id: row.task_id ?? null,
        payload: {
          session_id: sessionId,
          log_context: logContext,
          reason: 'sendOrResume_returned_null',
        },
      });
      this.emitFeedbackPending(sessionId, false);
      return;
    }
    markInboxItemsDelivered(items.map((i) => i.id));
    this.emitFeedbackPending(sessionId, false);
  }

  /**
   * Broadcast the transient pending/cleared delivery state for a session's
   * inbox items — see session_feedback_pending in ws/types.ts. Emitted
   * around every sendOrResume call in deliverUndeliveredInboxItems so a
   * resume-driven delivery (which can take as long as a full CLI --resume
   * spawn) is visible to the dashboard instead of looking dropped.
   */
  private emitFeedbackPending(sessionId: string, pending: boolean): void {
    this.emit('message', {
      type: 'session_feedback_pending',
      sessionId,
      pending,
    } satisfies ServerMessage);
  }

  /**
   * Send a message to a session, resuming it first if it is no longer live.
   * Reuses the original session ID so pull_requests.session_id linkage stays
   * valid and the UI card is updated in place (not a new card).
   *
   * If the session is still running, the message is delivered via send() directly.
   * Otherwise, a new AgentSession is spawned with --resume <sessionId> so the CLI
   * restores conversation history, full event forwarding (pr_opened, push_detected)
   * is wired via wireSession, and the message is sent after the first event.
   * A concurrency guard ensures only one respawn runs per session ID at a time.
   */
  async sendOrResume(
    sessionId: string,
    text: string,
    opts: { allowTerminal?: boolean; persistTextOnDefer?: boolean } = {},
  ): Promise<string | null> {
    // Live session — deliver directly. hasEnded excludes a session whose
    // process has already exited (session_ended broadcast) but whose map
    // entry hasn't been reaped yet by cleanupWorktree (run().then() only
    // fires after this synchronous session_ended handling returns) — writing
    // to that session's stdin lands on a closed pipe. That case, and any
    // other direct-send failure (e.g. a synchronous stdin.write() throw on
    // an already-exited process during the transient-failure backoff
    // window), is now detected via this.send()'s boolean return rather than
    // silently dropped — falling through to the respawn path below instead
    // delivers it via a fresh --resume process.
    const liveSession = this.sessions.get(sessionId);
    if (liveSession && !liveSession.hasEnded) {
      const delivered = this.send(sessionId, text);
      if (delivered) {
        resetSessionPokeRetryCount(sessionId);
        // Mirror the respawn path: ensure status reflects the resumed activity
        // so the UI doesn't keep rendering this session as idle. Terminal is
        // sticky — a done/error/killed row is never silently overwritten with
        // 'running' here; only an explicit allowTerminal caller may reopen it,
        // and that reopen is audited rather than folded into this status write.
        const row = getSession(sessionId);
        if (row && row.status !== 'running') {
          const isTerminal = TERMINAL_SESSION_STATUSES.has(row.status);
          if (isTerminal && !opts.allowTerminal) {
            logger.warn(
              `[SessionManager] sendOrResume: session ${sessionId.slice(0, 8)} is live but DB status is terminal (${row.status}) — not overwriting with running`,
            );
          } else {
            if (isTerminal) {
              recordEvent({
                event_type: 'session_terminal_reopened',
                actor_type: 'system',
                actor_id: sessionId,
                task_id: row.task_id ?? null,
                payload: { status_before: row.status },
              });
            }
            updateSessionStatus(sessionId, 'running');
            this.emit('message', {
              type: 'session_status',
              sessionId,
              status: 'running',
            } satisfies ServerMessage);
          }
        }
        return sessionId;
      }
      logger.warn(
        `[SessionManager] sendOrResume: direct send to live session ${sessionId.slice(0, 8)} failed — falling back to --resume respawn`,
      );
    }

    // Concurrency guard: if a respawn for this session is already in flight,
    // wait for it rather than double-spawning.
    const inflight = this.resumesInFlight.get(sessionId);
    if (inflight) return inflight;

    const promise = this._doSendOrResume(sessionId, text, opts);
    this.resumesInFlight.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.resumesInFlight.delete(sessionId);
    }
  }

  /**
   * Shared handling for a respawnSession() call made from _doSendOrResume's
   * live-poke path.
   *
   * On deferral (session === null), reports the actual gate that declined,
   * via lastRespawnDeferral — instead of the single hardcoded reason this
   * used to emit regardless of cause. The
   * operator's text was already persisted to the inbox by the caller before
   * the respawn attempt, so a deferral here never loses it — it stays
   * undelivered until a later respawn succeeds.
   *
   * On success, folds in any other still-undelivered inbox items for this
   * session (e.g. text from an earlier deferred poke) so a later successful
   * respawn delivers everything queued exactly once, rather than only the
   * latest text while older deferred pokes sit forgotten in the inbox.
   *
   * Deliberately does NOT stamp delivered_at — a successful respawnSession()
   * call only proves the process was spawned, not that the payload reached
   * its stdin/conversation. Callers stamp delivery only once that has been
   * separately confirmed (see the firstEvent handling in _doSendOrResume).
   */
  private resolveRespawnDelivery(
    sessionId: string,
    text: string,
    session: AgentSession | null,
  ): { combinedText: string; itemIds: number[] } | null {
    if (!session) {
      const deferral = this.lastRespawnDeferral;
      this.emit('message', {
        type: 'session_action_failed',
        sessionId,
        action: 'send_message',
        reason: deferral?.reason ?? 'usage_limit_deferred',
        detail:
          deferral?.detail ?? 'Plan usage window exhausted — deferring resume.',
      } satisfies ServerMessage);
      return null;
    }
    const pendingItems = listUndeliveredInboxItems(sessionId);
    const combinedText = pendingItems.length
      ? pendingItems.map((item) => item.payload).join('\n\n')
      : text;
    return {
      combinedText,
      itemIds: pendingItems.map((item) => item.id),
    };
  }

  private async _doSendOrResume(
    sessionId: string,
    text: string,
    opts: { allowTerminal?: boolean; persistTextOnDefer?: boolean } = {},
  ): Promise<string | null> {
    // Session not live — look up details from DB and re-launch with --resume
    const row = getSession(sessionId);
    if (!row) {
      logger.error(
        `[SessionManager] sendOrResume: session ${sessionId} not found in DB`,
      );
      this.emit('message', {
        type: 'session_action_failed',
        sessionId,
        action: 'send_message',
        reason: 'session_not_found',
        detail: `Session ${sessionId} not found.`,
      } satisfies ServerMessage);
      return null;
    }

    // Refuse to respawn sessions that reached a terminal state — done/error/killed
    // sessions are intentionally finished and must not be revived by stale feedback.
    // archived=1 is included alongside the terminal statuses: archiveAndEndSession
    // documents archival as "an explicit operator signal the session is done — reap
    // any live subprocess", so an archived session (even one left `idle`, which is
    // otherwise never terminal) must not be silently resumed either. PR-scoped
    // relaunches (relaunchFixerForPR) opt out via allowTerminal since a dead session
    // is exactly the case they exist to recover from.
    if (
      !opts.allowTerminal &&
      (row.status === 'done' ||
        row.status === 'error' ||
        row.status === 'killed' ||
        row.archived === 1)
    ) {
      logger.warn(
        `[SessionManager] sendOrResume: refusing to respawn terminal session ${sessionId} (status=${row.status}, archived=${row.archived})`,
      );
      this.emit('message', {
        type: 'session_action_failed',
        sessionId,
        action: 'send_message',
        reason: 'terminal_session',
        detail: `Session is in terminal state: ${row.status}`,
      } satisfies ServerMessage);
      return null;
    }

    // Planning sessions (groom/design/ops) still in `starting` haven't finished
    // completeStart() and aren't in this.sessions yet — respawning here would race
    // a second AgentSession into existence against the one completeStart() is still
    // constructing. Signal "still initializing" instead of falling through to the
    // worktree-respawn path below, which planning sessions never had a worktree for.
    if (isPlanningSession(row.session_type) && row.status === 'starting') {
      logger.info(
        `[SessionManager] sendOrResume: planning session ${sessionId} is still starting — declining respawn`,
      );
      this.emit('message', {
        type: 'session_action_failed',
        sessionId,
        action: 'send_message',
        reason: 'still_initializing',
        detail: 'Session is still starting up — try again in a moment.',
      } satisfies ServerMessage);
      return null;
    }

    const project = getProjectById(row.project_id ?? '');
    if (!project) {
      logger.error(
        `[SessionManager] sendOrResume: project not found for session ${sessionId}`,
      );
      return sessionId;
    }

    const projectDir = normalizePath(project.projectDir);
    // Reuse the original session ID for the worktree path — preserves
    // pull_requests.session_id linkage and UI card continuity.
    const worktreePath = path.join(
      projectDir,
      '.claude',
      'worktrees',
      sessionId,
    );

    // Fast path: if the session's recorded worktree already exists as a live git
    // worktree (has a .git pointer file), reuse it directly. This is the normal
    // resume path for idle sessions whose worktrees were preserved by the
    // chokepoint guard. No git worktree add needed — the session's own uncommitted
    // WIP is still there.
    //
    // Planning sessions (groom/design/ops) never get a per-session worktree —
    // completeStart() runs them directly against the project checkout (see
    // worktree_path: null at insertSession time). Point the fast path at
    // projectDir for them instead of the per-session path that never existed.
    const recordedPath =
      isPlanningSession(row.session_type) && !usesWorktree(row.session_type)
        ? (row.worktree_path ?? projectDir)
        : (row.worktree_path ?? worktreePath);
    if (
      recordedPath &&
      fs.existsSync(recordedPath) &&
      fs.existsSync(path.join(recordedPath, '.git'))
    ) {
      logger.info(
        `[SessionManager] sendOrResume reusing surviving worktree: path=${recordedPath}`,
      );
      const orchConfig = loadOrchestratorConfig(projectDir);
      const mode = runtimeSettings.session_mode;
      const runner =
        mode === 'api'
          ? new ApiSessionRunner(sessionId)
          : getCorporateMode().gates.dockerMandatory
            ? new DockerSessionRunner(sessionId)
            : new CliSessionRunner(sessionId);
      const mcpConfigPath = writeMcpConfig(
        projectDir,
        sessionId,
        orchConfig.mcp_servers,
        project.taskSource,
      );
      const fastPathSystemPromptPath =
        mode === 'cli' && row.task_url
          ? await this._buildAndWriteResumeSystemPrompt(
              row,
              project,
              orchConfig,
              projectDir,
              recordedPath,
            )
          : undefined;
      if (row.task_id) {
        const stale = getOtherRunningSessionsForTask(
          row.task_id,
          row.session_id,
          row.session_type,
        );
        for (const s of stale) {
          logger.info(
            `[SessionManager] sendOrResume: superseding stale session ${s.session_id.slice(0, 8)} for task ${row.task_id}`,
          );
          markSessionSuperseded(s.session_id, Date.now(), 'resume_superseded');
        }
      }
      // Persist before attempting the respawn so a usage-admission deferral
      // (or any other failure below) never loses the operator's text — see
      // resolveRespawnDelivery. Skipped when the caller's text is already
      // durable as inbox rows (persistTextOnDefer: false, e.g.
      // deliverUndeliveredInboxItems), since re-persisting it here would
      // duplicate it on every deferred retry.
      if (opts.persistTextOnDefer !== false) {
        enqueueFeedbackItem(sessionId, 'operator:message', text);
      }
      const session = this.respawnSession(
        row,
        recordedPath,
        orchConfig,
        runner,
        mcpConfigPath,
        fastPathSystemPromptPath,
        { allowReopenTerminal: opts.allowTerminal },
      );
      const respawnDelivery = this.resolveRespawnDelivery(
        sessionId,
        text,
        session,
      );
      if (!session || respawnDelivery === null) return null;
      resetSessionPokeRetryCount(sessionId);
      const { combinedText, itemIds } = respawnDelivery;

      // Proactive ceiling-escalation: if the session's persisted context occupancy
      // is at/over the HWM, spawn directly on large_task_model and deliver the
      // nudge via the 2s proactive timer instead of the first-event gate (which
      // never fires for context-maxed sessions). No first-event confirmation
      // signal exists on this path, so — as before this change — delivery is
      // considered confirmed as soon as the escalated session is spawned.
      if (isSessionAtContextCeiling(row)) {
        const largeModel = runtimeSettings.large_task_model!;
        session.setProactiveEscalation(
          largeModel,
          buildProactiveEscalationNudge(combinedText),
        );
        logger.info(
          `[SessionManager] sendOrResume: proactive ceiling-escalation for session ${sessionId.slice(0, 8)} ` +
            `(occupancy=${row.context_occupancy_tokens}/${AgentSession.contextWindowForModel(row.model ?? null)}, ` +
            `model=${row.model ?? 'unknown'} → ${largeModel})`,
        );
        this.wireSession(sessionId, session, projectDir, recordedPath);
        markInboxItemsDelivered(itemIds);
        return sessionId;
      }

      // send()'s boolean return is the real confirmation signal — see the
      // matching comment on the worktree-recreation respawn path below.
      let sendConfirmed = false;
      const firstEvent = new Promise<void>((resolve) => {
        session.once('message', () => {
          sendConfirmed = this.send(sessionId, combinedText);
          resolve();
        });
      });
      this.wireSession(sessionId, session, projectDir, recordedPath);

      const UNCONFIRMED_DELIVERY_TIMEOUT_MS = 30_000;
      const timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(
          () => resolve(true),
          UNCONFIRMED_DELIVERY_TIMEOUT_MS,
        );
        timer.unref();
        firstEvent.then(() => {
          clearTimeout(timer);
          resolve(false);
        });
      });

      if (timedOut || !sendConfirmed) {
        logger.warn(
          `[SessionManager] sendOrResume: respawned session ${sessionId.slice(0, 8)} did not confirm delivery of inbox item(s) [${itemIds.join(', ')}] ` +
            `(${timedOut ? 'no first event within 30s' : 'send() returned false'}) — leaving item(s) undelivered`,
        );
        recordEvent({
          event_type: 'inbox_delivery_unconfirmed',
          actor_type: 'system',
          actor_id: sessionId,
          project_id: row.project_id ?? null,
          task_id: row.task_id ?? null,
          payload: {
            session_id: sessionId,
            inbox_item_ids: itemIds,
            reason: timedOut ? 'first_event_timeout' : 'send_failed',
          },
        });
        return null;
      }

      markInboxItemsDelivered(itemIds);
      return sessionId;
    }

    // Planning sessions (groom/design/ops) never have a per-session worktree —
    // the fast path above resolves against projectDir, which always exists for a
    // valid project. Reaching here means the project checkout itself is missing;
    // never fall through to git worktree recreation, which planning sessions have
    // no branch/worktree state for.
    if (
      isPlanningSession(row.session_type) &&
      !usesWorktree(row.session_type)
    ) {
      const detail = `project checkout missing or not a git repo at ${recordedPath}`;
      logger.error(
        `[SessionManager] sendOrResume: ${detail} for planning session ${sessionId}`,
      );
      this.handlePokeFailure(row, 'planning_checkout_missing', detail);
      return sessionId;
    }

    // Resolve the starting point using dev as the base (no milestoneId available for resumed sessions).
    const { startingPoint, milestoneSlug } = resolveStartingPoint(
      project,
      null,
    );

    const isLocalOnly = project.gitMode === 'local-only';
    if (!isLocalOnly) {
      if (milestoneSlug) {
        try {
          ensureMilestoneBranch(milestoneSlug, projectDir, project.baseBranch);
        } catch (err) {
          logger.warn(
            `[SessionManager] sendOrResume: ensureMilestoneBranch failed (continuing): ${err}`,
          );
        }
      } else {
        const fetchOutcome = await fetchBaseBranchCoalesced(
          projectDir,
          project.baseBranch,
        );
        if (!fetchOutcome.ok && fetchOutcome.benignRefLock) {
          logger.info(
            `[SessionManager] sendOrResume: git fetch origin ${project.baseBranch} lost a ref-lock race but the ref already holds the fetched value (continuing): ${fetchOutcome.error}`,
          );
          recordEvent({
            event_type: 'base_fetch_ref_lock_benign',
            actor_type: 'system',
            actor_id: sessionId,
            project_id: row.project_id || null,
            task_id: row.task_id || null,
            payload: {
              baseBranch: project.baseBranch,
              error: String(fetchOutcome.error),
            },
          });
        } else if (!fetchOutcome.ok) {
          logger.warn(
            `[SessionManager] sendOrResume: git fetch origin ${project.baseBranch} failed (continuing with local ref): ${fetchOutcome.error}`,
          );
          setSessionLastErrorDetail(
            sessionId,
            `Pre-launch fetch of origin/${project.baseBranch} failed; session may be starting from a stale base: ${fetchOutcome.error}`,
          );
          recordEvent({
            event_type: 'base_fetch_failed',
            actor_type: 'system',
            actor_id: sessionId,
            project_id: row.project_id || null,
            task_id: row.task_id || null,
            payload: {
              baseBranch: project.baseBranch,
              error: String(fetchOutcome.error),
            },
          });
        }
      }
    }

    const worktreeBase =
      isLocalOnly || startingPoint !== project.baseBranch
        ? startingPoint
        : `origin/${project.baseBranch}`;

    const resumeFeatureBranch = row.task_name
      ? resolveResumeBranchSlug(row.task_name, row.task_id, projectDir)
      : null;

    // Prune stale worktree registrations before attempting re-attach.
    // This handles the common case where the worktree dir was deleted but the
    // branch is still marked as "checked out" in git's internal tracking.
    try {
      execSync(`git worktree prune`, { cwd: projectDir });
    } catch (pruneErr) {
      logger.warn(
        `[SessionManager] sendOrResume: git worktree prune failed (continuing): ${pruneErr}`,
      );
    }

    try {
      if (resumeFeatureBranch) {
        try {
          // Attach to existing branch — preserves all PR commits.
          await gitWorktreeAddWithRetry(
            `git worktree add "${worktreePath}" "${resumeFeatureBranch}"`,
            { cwd: projectDir },
          );
        } catch (attachErr) {
          const attachStderr =
            (attachErr as { stderr?: string | Buffer })?.stderr?.toString() ??
            '';
          // "already checked out" → branch is registered to a deleted worktree dir.
          // Prune the stale registration and retry the attach.
          const isAlreadyCheckedOut = attachStderr.includes(
            'already checked out',
          );
          if (isAlreadyCheckedOut) {
            try {
              execSync(`git worktree prune`, { cwd: projectDir });
            } catch {
              // best-effort
            }
            await gitWorktreeAddWithRetry(
              `git worktree add "${worktreePath}" "${resumeFeatureBranch}"`,
              { cwd: projectDir },
            );
          } else {
            // Branch doesn't exist locally (cleaned up) — try to recreate with -b.
            try {
              await gitWorktreeAddWithRetry(
                `git worktree add -b "${resumeFeatureBranch}" "${worktreePath}" ${worktreeBase}`,
                { cwd: projectDir },
              );
            } catch (createErr) {
              const createStderr =
                (
                  createErr as { stderr?: string | Buffer }
                )?.stderr?.toString() ?? '';
              if (/A branch named .* already exists/.test(createStderr)) {
                // -b failed: branch exists but attach failed with unrelated error.
                // Prune and reattach — the branch carries PR commits; never recreate.
                try {
                  execSync(`git worktree prune`, { cwd: projectDir });
                } catch {
                  // best-effort
                }
                await gitWorktreeAddWithRetry(
                  `git worktree add "${worktreePath}" "${resumeFeatureBranch}"`,
                  { cwd: projectDir },
                );
              } else {
                throw createErr;
              }
            }
          }
        }
      } else {
        await gitWorktreeAddWithRetry(
          `git worktree add --detach "${worktreePath}" ${worktreeBase}`,
          { cwd: projectDir },
        );
      }
    } catch (err) {
      const stderr =
        (err as { stderr?: string | Buffer })?.stderr?.toString() ?? '';
      const msg = `sendOrResume: worktree recreation failed for session ${sessionId.slice(0, 8)}: ${(err as Error).message}\nstderr: ${stderr}`;
      logger.error(`[SessionManager] ${msg}`);

      const isDegradedSpawn = isDegradedSpawnFailure(err);
      const reason = isDegradedSpawn
        ? BACKEND_SPAWN_DEGRADED_REASON
        : 'worktree_recreate_failed';
      const detail = isDegradedSpawn
        ? `${BACKEND_SPAWN_DEGRADED_MESSAGE}\nworktree recreation failed: ${(err as Error).message}`
        : `worktree recreation failed: ${(err as Error).message}`;

      this.handlePokeFailure(row, reason, stderr || detail);

      return sessionId;
    }

    const isUnixStylePath =
      worktreePath.startsWith('/c/') || worktreePath.startsWith('/C/');
    logger.info(
      `[SessionManager] sendOrResume worktree created: path=${worktreePath} startingPoint=${startingPoint}` +
        (isUnixStylePath
          ? ' [WARNING: Unix-style path detected — may not resolve correctly on Windows]'
          : ''),
    );

    // Load per-project orchestrator config so resumed sessions get the same
    // extra allowed tools (e.g. Bash(dotnet:*)) as freshly spawned ones.
    const orchConfig = loadOrchestratorConfig(projectDir);

    const mode = runtimeSettings.session_mode;
    const runner =
      mode === 'api'
        ? new ApiSessionRunner(sessionId)
        : getCorporateMode().gates.dockerMandatory
          ? new DockerSessionRunner(sessionId)
          : new CliSessionRunner(sessionId);

    const mcpConfigPath = writeMcpConfig(
      projectDir,
      sessionId,
      orchConfig.mcp_servers,
      project.taskSource,
    );

    const slowPathSystemPromptPath =
      mode === 'cli' && row.task_url
        ? await this._buildAndWriteResumeSystemPrompt(
            row,
            project,
            orchConfig,
            projectDir,
            worktreePath,
          )
        : undefined;

    // Reconcile zombie rows: mark any other running sessions for this task as
    // superseded before respawning, so no two live rows exist for the same task.
    if (row.task_id) {
      const stale = getOtherRunningSessionsForTask(
        row.task_id,
        row.session_id,
        row.session_type,
      );
      for (const s of stale) {
        logger.info(
          `[SessionManager] sendOrResume: superseding stale session ${s.session_id.slice(0, 8)} for task ${row.task_id}`,
        );
        markSessionSuperseded(s.session_id, Date.now(), 'resume_superseded');
      }
    }

    // Persist before attempting the respawn so a usage-admission deferral
    // (or any other failure below) never loses the operator's text — see
    // resolveRespawnDelivery. Skipped when the caller's text is already
    // durable as inbox rows (persistTextOnDefer: false, e.g.
    // deliverUndeliveredInboxItems), since re-persisting it here would
    // duplicate it on every deferred retry.
    if (opts.persistTextOnDefer !== false) {
      enqueueFeedbackItem(sessionId, 'operator:message', text);
    }

    // Shared helper: creates session with original ID, registers in map,
    // updates DB row to 'running', emits session_status.
    const session = this.respawnSession(
      row,
      worktreePath,
      orchConfig,
      runner,
      mcpConfigPath,
      slowPathSystemPromptPath,
      { allowReopenTerminal: opts.allowTerminal },
    );
    const respawnDelivery = this.resolveRespawnDelivery(
      sessionId,
      text,
      session,
    );
    if (!session || respawnDelivery === null) return null;
    resetSessionPokeRetryCount(sessionId);
    const { combinedText, itemIds } = respawnDelivery;

    // Register the pending text on the session so that if the resumed context
    // overflows, the escalated spawn re-delivers the original message rather
    // than dropping it. The session consumes this field in tryEscalateForOverflow().
    session.setPendingOverflowText(combinedText);

    // Proactive ceiling-escalation: if the session's persisted context occupancy
    // is at/over the HWM, spawn directly on large_task_model and deliver the
    // nudge via the 2s proactive timer instead of the first-event gate (which
    // never fires for context-maxed sessions). This path has no first-event
    // confirmation signal to gate on, so — as before this change — delivery
    // is considered confirmed as soon as the escalated session is spawned.
    if (isSessionAtContextCeiling(row)) {
      const largeModel = runtimeSettings.large_task_model!;
      session.setProactiveEscalation(
        largeModel,
        buildProactiveEscalationNudge(combinedText),
      );
      logger.info(
        `[SessionManager] sendOrResume: proactive ceiling-escalation for session ${sessionId.slice(0, 8)} ` +
          `(occupancy=${row.context_occupancy_tokens}/${AgentSession.contextWindowForModel(row.model ?? null)}, ` +
          `model=${row.model ?? 'unknown'} → ${largeModel})`,
      );
      // wireSession wires message + pr_opened + push_detected forwarding and starts
      // run() fire-and-forget. The proactive 2s timer in AgentSession.run() delivers
      // the nudge text to the large-model session without a first-event gate.
      this.wireSession(sessionId, session, projectDir, worktreePath);
      markInboxItemsDelivered(itemIds);
      return sessionId;
    }

    // Register the first-event listener BEFORE wireSession starts run() to
    // avoid a race where the first message arrives before the listener is set.
    // send()'s boolean return — not just the resumed session's existence — is
    // the real confirmation signal: it is false whenever the stdin write did
    // not reach the process, and only inserts the user_message event (the
    // signal a live delivery already produces) when it returns true. Stamping
    // delivered_at on anything less would repeat the bug this guards against:
    // a session that was merely spawned, but never actually received the text.
    let sendConfirmed = false;
    const firstEvent = new Promise<void>((resolve) => {
      session.once('message', () => {
        sendConfirmed = this.send(sessionId, combinedText);
        resolve();
      });
    });

    // wireSession wires message + pr_opened + push_detected forwarding and starts
    // run() fire-and-forget with cleanup. This is the single wiring point for all
    // resume paths, preventing the divergence that was silently dropping pr_opened.
    this.wireSession(sessionId, session, projectDir, worktreePath);

    const UNCONFIRMED_DELIVERY_TIMEOUT_MS = 30_000;
    const timedOut = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => resolve(true),
        UNCONFIRMED_DELIVERY_TIMEOUT_MS,
      );
      timer.unref();
      firstEvent.then(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (timedOut || !sendConfirmed) {
      logger.warn(
        `[SessionManager] sendOrResume: respawned session ${sessionId.slice(0, 8)} did not confirm delivery of inbox item(s) [${itemIds.join(', ')}] ` +
          `(${timedOut ? 'no first event within 30s' : 'send() returned false'}) — leaving item(s) undelivered`,
      );
      recordEvent({
        event_type: 'inbox_delivery_unconfirmed',
        actor_type: 'system',
        actor_id: sessionId,
        project_id: row.project_id ?? null,
        task_id: row.task_id ?? null,
        payload: {
          session_id: sessionId,
          inbox_item_ids: itemIds,
          reason: timedOut ? 'first_event_timeout' : 'send_failed',
        },
      });
      return null;
    }

    markInboxItemsDelivered(itemIds);
    return sessionId;
  }

  /**
   * Idempotently remove a lingering in-memory session entry. Used before
   * relaunchFixerForPR spawns a replacement so a stale map reference (session
   * marked dead in the DB but not yet cleaned up in memory) can't collide with
   * the new AgentSession instance.
   */
  private evictDeadSessionEntry(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Periodic defense-in-depth sweep: drop any in-memory `this.sessions` entry
   * whose backing DB row is terminal (done/error/killed) or missing entirely,
   * releasing its concurrency slot and revoking its stage credential. Mirrors
   * WorktreeReconciler's periodic-Scheduler-job pattern, but operates on the
   * in-memory map instead of the filesystem, so it must live on SessionManager
   * where `this.sessions` is accessible. Never touches a non-terminal (live)
   * session's entry.
   */
  reconcileSessionsMap(): { dropped: number } {
    let dropped = 0;
    for (const sessionId of Array.from(this.sessions.keys())) {
      const row = getSession(sessionId);
      if (row && !TERMINAL_SESSION_STATUSES.has(row.status)) {
        continue;
      }
      // The row is terminal (or gone entirely) but this map entry
      // survived — nothing upstream is guaranteed to have reaped its
      // subprocess (that's exactly the class of bug this sweep exists to
      // catch), so verify-and-escalate before dropping the last reference
      // to it. endSession() only touches the process, never DB status, so
      // it's safe even though the row may already be a terminal status
      // this AgentSession never wrote itself (e.g. an external actor).
      const session = this.sessions.get(sessionId);
      if (session) {
        Promise.resolve(session.endSession()).catch((err) => {
          logger.error(
            `[SessionManager] reconcileSessionsMap teardown failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`,
          );
        });
      }
      this.evictDeadSessionEntry(sessionId);
      const revocationReason = row
        ? `terminal_status:${row.status}`
        : 'missing_db_row';
      revokeStageCredential(sessionId, revocationReason);
      revokeRouteCredential(sessionId, revocationReason);
      if (row) {
        // The row reached a terminal status through some path other than
        // this session's own clean-exit (an external actor, per this
        // method's own doc comment above) — that path may never have
        // broadcast session_ended, which is the only signal
        // StuckSessionMonitor clears its timers on. Emit it here so a stray
        // timer for this session doesn't keep firing after the row already
        // shows the session concluded.
        this.emit('message', {
          type: 'session_ended',
          sessionId,
          status: row.status,
          ...(row.task_id && { taskId: row.task_id }),
        } satisfies ServerMessage);
      }
      dropped++;
      recordEvent({
        event_type: 'session_map_entry_dropped',
        actor_type: 'system',
        actor_id: sessionId,
        payload: {
          session_id: sessionId,
          status: row ? row.status : null,
          revocation_reason: revocationReason,
        },
      });
      logger.info(
        `[SessionManager] reconcileSessionsMap: dropped stale in-memory entry for session ${sessionId.slice(0, 8)} (${row ? `status=${row.status}` : 'missing DB row'})`,
      );
    }
    if (dropped > 0) {
      logger.info(
        `[SessionManager] reconcileSessionsMap: sweep complete — dropped ${dropped} stale entr${dropped === 1 ? 'y' : 'ies'}`,
      );
    }
    return { dropped };
  }

  /**
   * DB → OS reconciliation sweep: terminalizes a non-terminal planning
   * session row whose OS subprocess does not exist, and drops its
   * in-memory entry — the mirror-image counterpart to reconcileSessionsMap
   * above (memory → DB), which only ever drops a stale in-memory entry and
   * never writes a terminal status itself. Delegates the actual sweep logic
   * to sessionLivenessReconciler.ts, wiring this instance's map-eviction so
   * a reconciled session's in-memory entry (if any) is dropped in the same
   * pass — closing the gap where a stale in-memory entry paired with a
   * non-terminal DB row is unreachable by either sweep alone.
   */
  reconcilePlanningSessionLiveness(): SessionLivenessReconcileResult {
    return reconcileSessionLiveness({
      evictSessionMapEntry: (sessionId) =>
        this.evictDeadSessionEntry(sessionId),
      tryMarkPlanningTerminal: this.planningTerminalChecker ?? undefined,
    });
  }

  /**
   * Wires PlanningOrchestrator.tryTerminalizeIfComplete in — called once
   * from server.ts after both instances exist (PlanningOrchestrator takes
   * this SessionManager in its own constructor, so the dependency can't run
   * the other direction).
   */
  setPlanningTerminalChecker(checker: (sessionId: string) => boolean): void {
    this.planningTerminalChecker = checker;
  }

  /**
   * Non-planning counterpart to reconcilePlanningSessionLiveness above —
   * covers standard/review/depth_review session rows, which have no other
   * periodic OS-process-liveness sweep. See
   * sessionLivenessReconciler.reconcileNonPlanningSessionLiveness.
   */
  reconcileNonPlanningSessionLiveness(): SessionLivenessReconcileResult {
    return reconcileNonPlanningSessionLiveness({
      evictSessionMapEntry: (sessionId) =>
        this.evictDeadSessionEntry(sessionId),
    });
  }

  /**
   * OS → DB reconciliation sweep: reaps a claude OS process whose session
   * row is already terminal (or missing entirely) — the fourth cell in the
   * coverage matrix none of the three sweeps above can reach. See
   * sessionLivenessReconciler.reconcileOrphanProcesses.
   */
  reconcileOrphanProcesses(): Promise<OrphanProcessReconcileResult> {
    return reconcileOrphanProcesses({
      evictSessionMapEntry: (sessionId) =>
        this.evictDeadSessionEntry(sessionId),
    });
  }

  /**
   * Relaunch a coding fixer on a PR's existing branch when the implementing
   * session has died (or is idle) and the normal gate-failure /
   * conflict-nudge delivery path (sendOrResume to job.sessionId) can't reach
   * anyone. PR-scoped: bound to `pr.session_id`'s branch/worktree, not to task
   * dispatch — deliberately does NOT consult hasLiveSessionForTask, since that
   * check exists for the initial task-launch decision (AutoLauncher), not for
   * recovering a specific stalled PR.
   *
   * Resolution by session state:
   *  - idle, worktree present: resume in place (delegates to sendOrResume).
   *  - idle, worktree missing: anomaly — surface to the operator, no relaunch.
   *  - terminal (done/error/killed), worktree present: resume in place with
   *    --resume, bypassing the terminal refusal that sendOrResume enforces.
   *  - terminal, worktree missing (confirmed dead): recreate a worktree
   *    attached to the PR's existing branch and spawn fresh with --resume.
   *
   * Returns the session id on success, null if no relaunch was attempted
   * (missing session_id, or the idle+no-worktree operator-surface case), or
   * `{ outcome: 'session_row_missing' }` when pr.session_id is set but its
   * sessions row is gone (e.g. deleted by deleteGhostSessions/DELETE
   * /api/sessions/:id before this durable-anchor guard existed, or by any
   * future deleter) — distinguishable from the idle-with-no-worktree null
   * so a caller can tell "nothing to resume, by design" apart from
   * "the anchor this recovery path depends on no longer exists".
   */
  async relaunchFixerForPR(
    pr: { pr_number: number; repo: string; session_id: string | null },
    prompt: string,
  ): Promise<string | FixerRelaunchFailure | null> {
    const sessionId = pr.session_id;
    if (!sessionId) {
      logger.warn(
        `[SessionManager] relaunchFixerForPR: PR #${pr.pr_number} (${pr.repo}) has no session_id — cannot relaunch`,
      );
      return null;
    }

    // Evict any lingering in-memory entry for the dead session id before
    // respawning — see evictDeadSessionEntry doc.
    this.evictDeadSessionEntry(sessionId);

    const row = getSession(sessionId);
    if (!row) {
      logger.error(
        `[SessionManager] relaunchFixerForPR: session ${sessionId} not found in DB`,
      );
      return { outcome: 'session_row_missing' };
    }

    const isTerminal =
      row.status === 'done' ||
      row.status === 'error' ||
      row.status === 'killed';

    if (!isTerminal) {
      const project = getProjectById(row.project_id ?? '');
      const projectDir = project ? normalizePath(project.projectDir) : null;
      const recordedPath =
        row.worktree_path ??
        (projectDir
          ? path.join(projectDir, '.claude', 'worktrees', sessionId)
          : null);
      const worktreePresent =
        !!recordedPath &&
        fs.existsSync(recordedPath) &&
        fs.existsSync(path.join(recordedPath, '.git'));

      if (!worktreePresent) {
        logger.warn(
          `[SessionManager] relaunchFixerForPR: idle session ${sessionId} has no worktree — surfacing to operator instead of relaunching`,
        );
        setSessionPauseReason(sessionId, 'stalled_idle');
        this.emit('message', {
          type: 'session_action_failed',
          sessionId,
          action: 'relaunch_fixer',
          reason: 'worktree_missing',
          detail: `Idle session has no worktree at ${recordedPath ?? '(unknown)'}`,
        } satisfies ServerMessage);
        return null;
      }
    }

    // Idle-with-worktree resumes normally; terminal sessions bypass the
    // terminal refusal since PR-scoped recovery is exactly what this is for.
    return this.sendOrResume(sessionId, prompt, { allowTerminal: true });
  }

  async shutdownAll(): Promise<void> {
    const pauses = [...this.sessions.values()].map((s) => s.gracefulPause());
    await Promise.allSettled(pauses);
  }

  /**
   * Backstop for the terminal-transition hook — historically reaped every
   * staged/approved intent left behind by a session that reached a terminal
   * status (done/error/killed) without going through the hook, keyed on
   * status alone. sweepStagedIntentsForTerminalSessions (db/queries.ts) is
   * now permanently a no-op for the reason documented there: a session's
   * termination is not a disposition of the artifacts it already staged.
   * Kept as the documented call site for that function and for any future
   * content-based backstop.
   */
  reapStagedIntentsBackstopSweep(): number {
    const swept = sweepStagedIntentsForTerminalSessions(
      'session_terminal_backstop_sweep',
      Date.now(),
    );
    for (const { sessionId, expired } of swept) {
      if (expired.length === 0) continue;
      try {
        enqueueFeedbackItem(
          sessionId,
          'staged-intent-expiry',
          formatExpiredIntentsFeedback(expired),
        );
      } catch {
        // Best-effort — DB may be unavailable or mocked without this function.
      }
    }
    return swept.reduce((total, { expired }) => total + expired.length, 0);
  }

  /**
   * At boot, find all sessions with undelivered inbox items and deliver them
   * via sendOrResume so idle/exited sessions receive pending feedback.
   */
  async reconcileInboxAtBoot(): Promise<void> {
    const sessionIds = listSessionsWithUndeliveredInboxItems();
    if (sessionIds.length === 0) return;

    logger.info(
      `[SessionManager] inbox boot reconciliation: ${sessionIds.length} session(s) with undelivered items`,
    );

    await Promise.allSettled(
      sessionIds.map((sessionId) =>
        this.deliverUndeliveredInboxItems(
          sessionId,
          'inbox boot reconciliation',
        ),
      ),
    );
  }

  /**
   * Redeliver whatever is sitting undelivered in a session's feedback inbox.
   * Thin public wrapper around deliverUndeliveredInboxItems for callers (e.g.
   * StalledPRReconciler re-driving a needs_changes PR whose feedback never
   * reached an idle implementing session) that need to know whether delivery
   * actually happened.
   *
   * Returns true when items were found and (re)sent to the session.
   */
  async redeliverUndeliveredFeedback(sessionId: string): Promise<boolean> {
    const before = listUndeliveredInboxItems(sessionId).length;
    if (before === 0) return false;
    await this.deliverUndeliveredInboxItems(
      sessionId,
      'redeliverUndeliveredFeedback',
    );
    return listUndeliveredInboxItems(sessionId).length < before;
  }

  /**
   * Scheduled retry for inbox items a prior delivery attempt left undelivered
   * (e.g. respawnSession's memory-admission gate deferring the respawn) —
   * without this, such an item has no next attempt short of a backend
   * restart (reconcileInboxAtBoot) or the session happening to already have
   * an open PR (redeliverUndeliveredFeedback via StalledPRReconciler). Scoped
   * to non-terminal, non-archived sessions only: terminal-session delivery
   * stays reserved for reconcileInboxAtBoot/enqueueFeedback's
   * attemptTerminalResume opt-in, so this sweep never re-drives that path on
   * its own initiative. The memory-admission gate itself still applies on
   * every retry — this only removes the once-then-never ceiling on attempts.
   */
  async sweepUndeliveredInbox(): Promise<{ itemsProcessed: number }> {
    const sessionIds = listNonTerminalSessionsWithUndeliveredInboxItems();
    if (sessionIds.length === 0) return { itemsProcessed: 0 };

    let itemsProcessed = 0;
    await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        const before = listUndeliveredInboxItems(sessionId).length;
        await this.deliverUndeliveredInboxItems(
          sessionId,
          'inbox scheduled retry',
        );
        const after = listUndeliveredInboxItems(sessionId).length;
        itemsProcessed += Math.max(0, before - after);
      }),
    );
    return { itemsProcessed };
  }
}
