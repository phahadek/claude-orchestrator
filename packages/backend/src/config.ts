import { getSecret } from './security/secrets';
import { getOrchestratorConfig } from './config/appConfig';
import type { NonMilestoneSourceConfig } from './tasks/TaskBackend';

export interface Board {
  /** Milestone row id — used as the milestoneId for WS fetch_tasks. */
  id: string;
  /** Notion database id (milestone.source_id) — used internally by NotionTaskBackend. */
  sourceId: string;
  name: string;
}

export interface ProjectConfig {
  id: string; // unique key, e.g. "claude-orchestrator"
  name: string;
  projectDir: string; // absolute path to the repo root
  contextUrl: string;
  boardId: string; // default/active board (backwards compat — first milestone)
  boards?: Board[]; // multi-milestone support — derived from milestones table
  githubRepo?: string; // "owner/repo" — optional; enables PR features
  taskSource: 'notion' | 'yaml' | 'jira' | 'github'; // honored by getTaskBackend(projectId)
  gitMode: 'github' | 'local-only'; // 'github' (default) or 'local-only' (no GitHub remote)
  autoLaunchEnabled: boolean; // per-project toggle for the AutoLauncher
  autoLaunchMilestoneId: string | null; // milestone the AutoLauncher polls; null = first milestone
  autoMergeEnabled: boolean; // per-project toggle for the AutoMerger
  milestoneBranching?: 'two_tier' | 'flat' | null; // NULL/undefined = fall back to corporate-mode default
  nonMilestoneSourceConfig?: NonMilestoneSourceConfig | null; // config for the non-milestone task pool
  dataResidencyConfirmed: boolean; // ZDR attestation — user confirms Anthropic ZDR is enabled
  baseBranch: string; // default branch used when creating worktrees (e.g. 'dev' or 'main')
}

function resolveClaudePath(): string {
  const explicit = process.env.CLAUDE_PATH;
  if (explicit) return explicit;
  // On Windows, spawn('claude', ..., { cwd }) fails if claude isn't in the
  // system PATH. Resolve the full path at startup so it always works.
  try {
    const { execSync } =
      require('child_process') as typeof import('child_process');
    return execSync(
      process.platform === 'win32' ? 'where claude' : 'which claude',
      {
        encoding: 'utf8',
      },
    )
      .trim()
      .split('\n')[0];
  } catch {
    return 'claude'; // fallback — hope it's on PATH
  }
}

/** Convert Git Bash paths like /c/Users/... to C:/Users/... for Windows Node. */
export function normalizePath(p: string): string {
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(p)) {
    return p[1].toUpperCase() + ':' + p.slice(2);
  }
  return p;
}

const _oc = getOrchestratorConfig();

export const config = {
  notionApiKey: _oc.notion.apiKey,
  sqlitePath: _oc.db.path,
  port: _oc.server.port,
  projectDir: normalizePath(process.env.PROJECT_DIR ?? process.cwd()),
  claudePath: resolveClaudePath(),
  maxConcurrentCodeSessions: Number(
    process.env.MAX_CONCURRENT_CODE_SESSIONS ?? 20,
  ),
  anthropicApiKey: getSecret('ANTHROPIC_API_KEY') ?? '',
};

export const GITHUB_TOKEN = _oc.github.token;
export const GITHUB_REPO = _oc.github.repo;

// ── Jira integration ─────────────────────────────────────────────────────────
export const JIRA_HOST = process.env.JIRA_HOST ?? ''; // e.g. https://mycompany.atlassian.net
export const JIRA_TOKEN = getSecret('JIRA_TOKEN') ?? ''; // API token or PAT
export const JIRA_EMAIL = process.env.JIRA_EMAIL ?? ''; // email for basic auth (optional)

export const AUTO_REVIEW_ENABLED = _oc.autoReview.enabled;
export const AUTO_REVIEW_CONCURRENCY = _oc.autoReview.concurrency;

// ── Session Bash output / timeout caps ───────────────────────────────────────
// Single source for both CLI (spawn) and API (Agent SDK) mode.
// Set on process.env so spawned sessions inherit without explicit env override.
export const BASH_MAX_OUTPUT_LENGTH = Number(
  process.env.BASH_MAX_OUTPUT_LENGTH ?? 30000,
);
export const BASH_DEFAULT_TIMEOUT_MS = Number(
  process.env.BASH_DEFAULT_TIMEOUT_MS ?? 300000,
);
process.env.BASH_MAX_OUTPUT_LENGTH = String(BASH_MAX_OUTPUT_LENGTH);
process.env.BASH_DEFAULT_TIMEOUT_MS = String(BASH_DEFAULT_TIMEOUT_MS);

export const ALLOWED_TOOLS = [
  'Bash(git:*)',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(node:*)',
  'Bash(tsc:*)',
  'Bash(cd:*)',
  'Bash(which:*)',
  'Bash(where:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(echo:*)',
  'Bash(mkdir:*)',
  'Bash(cp:*)',
  'Bash(mv:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(find:*)',
  'Bash(grep:*)',
  'Bash(sort:*)',
  'Bash(pwd:*)',
  'mcp__claude_ai_Notion__*',
  // GitHub MCP — explicit allowlist; create_pull_request and merge_pull_request are
  // backend-owned and must not be available to session agents.
  'mcp__github__add_issue_comment',
  'mcp__github__create_branch',
  'mcp__github__create_issue',
  'mcp__github__create_or_update_file',
  'mcp__github__create_pull_request_review',
  'mcp__github__fork_repository',
  'mcp__github__get_file_contents',
  'mcp__github__get_issue',
  'mcp__github__get_pull_request',
  'mcp__github__get_pull_request_comments',
  'mcp__github__get_pull_request_files',
  'mcp__github__get_pull_request_reviews',
  'mcp__github__get_pull_request_status',
  'mcp__github__list_commits',
  'mcp__github__list_issues',
  'mcp__github__list_pull_requests',
  'mcp__github__push_files',
  'mcp__github__search_code',
  'mcp__github__search_issues',
  'mcp__github__search_repositories',
  'mcp__github__search_users',
  'mcp__github__update_issue',
  'mcp__github__update_pull_request_branch',
];

function hydrateProject(p: {
  id: string;
  name: string;
  projectDir: string;
  contextUrl: string | null;
  githubRepo: string | null;
  taskSource: 'notion' | 'yaml' | 'jira' | 'github';
  gitMode: 'github' | 'local-only';
  autoLaunchEnabled: boolean;
  autoLaunchMilestoneId: string | null;
  autoMergeEnabled: boolean;
  milestoneBranching: 'two_tier' | 'flat' | null;
  nonMilestoneSourceConfig: NonMilestoneSourceConfig | null;
  dataResidencyConfirmed: boolean;
  baseBranch: string;
  milestones: { id: string; sourceId: string | null; name: string }[];
}): ProjectConfig {
  // boards[].id is now the milestone row id (used as milestoneId for fetch_tasks).
  // boards[].sourceId is the Notion database id (used internally by NotionTaskBackend).
  // YAML projects keep their milestones in boards as well — their sourceId is empty.
  const boards: Board[] = p.milestones.map((m) => ({
    id: m.id,
    sourceId: m.sourceId ?? '',
    name: m.name,
  }));
  const config: ProjectConfig = {
    id: p.id,
    name: p.name,
    projectDir: p.projectDir,
    contextUrl: p.contextUrl ?? '',
    boardId: boards[0]?.id ?? '',
    taskSource: p.taskSource,
    gitMode: p.gitMode,
    autoLaunchEnabled: p.autoLaunchEnabled,
    autoLaunchMilestoneId: p.autoLaunchMilestoneId,
    autoMergeEnabled: p.autoMergeEnabled,
    milestoneBranching: p.milestoneBranching,
    nonMilestoneSourceConfig: p.nonMilestoneSourceConfig,
    dataResidencyConfirmed: p.dataResidencyConfirmed,
    baseBranch: p.baseBranch ?? 'dev',
  };
  if (boards.length > 0) config.boards = boards;
  if (p.githubRepo) config.githubRepo = p.githubRepo;
  return config;
}

export function getProjectById(id: string): ProjectConfig | undefined {
  // Lazy import avoids a circular dependency between config <-> ProjectService.
  const { ProjectService } =
    require('./projects/ProjectService') as typeof import('./projects/ProjectService');
  const project = ProjectService.getById(id);
  return project ? hydrateProject(project) : undefined;
}

export function getAllProjects(): ProjectConfig[] {
  const { ProjectService } =
    require('./projects/ProjectService') as typeof import('./projects/ProjectService');
  return ProjectService.list().map(hydrateProject);
}

export function getProjectByGithubRepo(
  githubRepo: string,
): ProjectConfig | undefined {
  return getAllProjects().find((p) => p.githubRepo === githubRepo);
}

export interface RuntimeSettings {
  max_concurrent_code_sessions: number;
  auto_review_concurrency: number;
  auto_review: boolean;
  card_preview_lines: number;
  code_session_model: string;
  review_session_model: string;
  /** Session launch mode: 'cli' uses the claude subprocess, 'api' uses the Agent SDK. */
  session_mode: 'cli' | 'api';
  /** Global concurrency cap for AutoLauncher-spawned code sessions. */
  auto_launch_concurrency: number;
  /** AutoLauncher poll interval in milliseconds. */
  auto_launch_poll_interval_ms: number;
  /** Stuck-session timer: seconds before emitting a notify toast. */
  session_notify_threshold_seconds: number;
  /** Stuck-session timer: seconds before injecting a pause message. */
  session_pause_threshold_seconds: number;
  /** After pause, seconds during which a tool_use triggers a hard-stop. */
  session_hard_stop_window_seconds: number;
  /** Auto-merger: seconds between CI status polls while waiting for green. */
  ci_poll_interval_seconds: number;
  /** Auto-merger: minutes before the merge attempt gives up and pauses. */
  ci_poll_max_minutes: number;
  /** Max review iterations before escalating to manual. */
  max_review_iterations: number;
  /** Auto-merger: minutes after which a stale auto_merge_failed pause is cleared and retried. */
  auto_merge_failed_clear_minutes: number;
  /** When true, projects with no explicit milestone_branching default to two_tier mode.
   *  Also blocks non-conforming PRs rather than warning. */
  corporate_mode_enabled: boolean;
  /** PRBootSweep: how many days back to look for recently-merged/closed PRs to backfill. */
  pr_boot_sweep_merged_lookback_days: number;
  /** ConcludedSessionArchiver: when true, the periodic sweep runs. */
  auto_archive_enabled: boolean;
  /** ConcludedSessionArchiver: grace period in minutes before archiving concluded sessions. */
  auto_archive_grace_minutes: number;
  /** ConcludedSessionArchiver: interval in minutes between archiver sweeps. */
  auto_archive_sweep_interval_minutes: number;
}

/** Mutable in-memory settings, seeded from env and overridden by DB on startup. */
export const runtimeSettings: RuntimeSettings = {
  max_concurrent_code_sessions: Number(
    process.env.MAX_CONCURRENT_CODE_SESSIONS ?? 20,
  ),
  auto_review_concurrency: _oc.autoReview.concurrency,
  auto_review: _oc.autoReview.enabled,
  card_preview_lines: Number(process.env.CARD_PREVIEW_LINES ?? 3),
  code_session_model: '',
  review_session_model: '',
  session_mode: process.env.SESSION_MODE === 'api' ? 'api' : 'cli',
  auto_launch_concurrency: Number(process.env.AUTO_LAUNCH_CONCURRENCY ?? 1),
  auto_launch_poll_interval_ms: Number(
    process.env.AUTO_LAUNCH_POLL_INTERVAL_MS ?? 60_000,
  ),
  session_notify_threshold_seconds: Number(
    process.env.SESSION_NOTIFY_THRESHOLD_SECONDS ?? 3600,
  ),
  session_pause_threshold_seconds: Number(
    process.env.SESSION_PAUSE_THRESHOLD_SECONDS ?? 7200,
  ),
  session_hard_stop_window_seconds: Number(
    process.env.SESSION_HARD_STOP_WINDOW_SECONDS ?? 60,
  ),
  ci_poll_interval_seconds: Number(process.env.CI_POLL_INTERVAL_SECONDS ?? 30),
  ci_poll_max_minutes: Number(process.env.CI_POLL_MAX_MINUTES ?? 30),
  max_review_iterations: 3,
  auto_merge_failed_clear_minutes: Number(
    process.env.AUTO_MERGE_FAILED_CLEAR_MINUTES ?? 10,
  ),
  corporate_mode_enabled: process.env.CORPORATE_MODE === 'true',
  pr_boot_sweep_merged_lookback_days: Number(
    process.env.PR_BOOT_SWEEP_MERGED_LOOKBACK_DAYS ?? 30,
  ),
  auto_archive_enabled: process.env.AUTO_ARCHIVE_ENABLED !== 'false',
  auto_archive_grace_minutes: Number(
    process.env.AUTO_ARCHIVE_GRACE_MINUTES ?? 30,
  ),
  auto_archive_sweep_interval_minutes: Number(
    process.env.AUTO_ARCHIVE_SWEEP_INTERVAL_MINUTES ?? 5,
  ),
};
