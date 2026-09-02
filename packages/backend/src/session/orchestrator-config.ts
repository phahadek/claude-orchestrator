import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { logger } from '../logger';
import {
  ALLOWED_TOOLS,
  GROOM_ALLOWED_TOOLS,
  DESIGN_ALLOWED_TOOLS,
  OPS_ALLOWED_TOOLS,
  INVESTIGATE_ALLOWED_TOOLS,
  DOCS_ALLOWED_TOOLS,
  DEPTH_REVIEW_ALLOWED_TOOLS,
  docsWebFetchTools,
  NOTION_READ_MCP_TOOLS,
  runtimeSettings,
} from '../config';
import {
  isPlanningSession,
  isInvestigateSession,
  isGateVerifySession,
} from './sessionPredicates';

/**
 * The closed set of session-kind keys a project's `.claude-orchestrator.yml`
 * can pre-grant capabilities to — the six session kinds
 * resolvePreGrantSessionKind can resolve a spawn to. 'gate-verify' and
 * 'investigate' are sub-kinds of sessionType 'ops', resolved from `task_id`
 * the same way isGateVerifySession/isInvestigateSession do; the remaining
 * four map 1:1 onto their SessionType literal.
 */
export const PRE_GRANT_SESSION_KINDS = [
  'gate-verify',
  'investigate',
  'ops',
  'groom',
  'design',
  'docs',
] as const;

export type PreGrantSessionKind = (typeof PRE_GRANT_SESSION_KINDS)[number];

/**
 * Locates the central config tree (the sibling `config/` checkout holding
 * `procedures.md`, `task-writing.md`, and `projects/<key>/` per-project
 * docs). Mirrors groom/groomLoad.ts#resolveConfigDir's exact resolution
 * order (env var, then `../config`/`../../config` relative to the project
 * checkout) but is kept as its own copy here rather than importing
 * groomLoad.ts directly: that module pulls in NotionClient, ProjectService,
 * and a promisified `execFile` at import time, which is unwanted weight on
 * every dispatched session's spawn path (this function runs on every
 * CliSessionRunner/DockerSessionRunner spawn, not just groom sessions).
 */
function resolveConfigDir(projectDir: string): string | null {
  const explicit = process.env.ORCHESTRATOR_CONFIG_DIR;
  if (explicit) return path.resolve(explicit);
  for (const c of [
    path.resolve(projectDir, '..', 'config'),
    path.resolve(projectDir, '..', '..', 'config'),
  ]) {
    if (fs.existsSync(path.join(c, 'projects'))) return c;
  }
  return null;
}

/**
 * A single analyze-gate command with an optional path-trigger glob list. When
 * `trigger_paths` is set, the command is skipped for a PR whose diff touches
 * none of those globs (minimatch, matched against `git diff --name-only`
 * paths — see pathDiffPredicate.ts's matchesPathDiff). Omitted/empty
 * `trigger_paths` means "always run", matching plain-string entries.
 *
 * `transient_output_patterns` is a list of regexes (tested against a failed
 * command's combined stdout/stderr) identifying diff-orthogonal infra noise
 * — network blips, registry 5xxs, DNS failures — that should mark the
 * failure as transient (`is_transient`) alongside the existing timeout/OOM
 * detection, even though the command itself didn't time out or get killed.
 */
interface AnalyzeCommandEntry {
  command: string;
  trigger_paths?: string[];
  transient_output_patterns?: string[];
}

/** Backward-compatible: a bare string is a command with no path trigger (always runs, no content-hash caching). */
export type AnalyzeCommand = string | AnalyzeCommandEntry;

export interface OrchestratorConfig {
  /**
   * Commands run in the worktree before opening the PR (mechanical fixes only).
   * A command MAY contain `{{changed_files}}` — the runner replaces it with the
   * session's changed files (`git diff --name-only <baseBranch>...HEAD`), quoted
   * individually, so formatters only touch changed files. When the changed-file
   * set is empty the command is skipped entirely (no whole-repo run). Commands
   * without the placeholder run unchanged over the whole worktree.
   */
  autofix: string[];
  /** Commands the session runs before opening the PR (injected into CLAUDE.md). */
  verify: string[];
  /** GitHub check-run names treated as authoritative for pass/fail. */
  ci_check_name: string[];
  /** Extra Bash tool permission patterns merged with the base allowed-tools set. */
  allowed_tools: string[];
  /** Bash rules (Rule 5+). Each item is the full rule text. */
  bash_rules: string[];
  /** Per-project coding-session guidance, rendered as a "## Project Rules" section (distinct from bash_rules) in the coding-session CLAUDE.md. */
  session_rules: string[];
  /** Per-project review-session enforcement criteria, rendered into the review-session prompt. */
  review_rules: string[];
  /** Path to a script run after worktree creation, relative to the project root. */
  bootstrap_script: string;
  /** Env var names that must be set after bootstrap. Launch aborts if any are missing. */
  required_env: string[];
  /** Paths relative to the worktree root that must exist after bootstrap. Launch aborts if any are missing. */
  required_files: string[];
  /**
   * MCP server definitions to restrict sessions to. When defined, sessions only
   * see the listed MCP servers instead of inheriting all user-level servers.
   * Each key is the server name; value is the server config object.
   * Undefined = no override (all user-level servers are inherited).
   */
  mcp_servers?: Record<string, unknown>;
  /** Commands the orchestrator runs as authoritative tests, per head-SHA. Empty = feature off. */
  test: string[];
  /** Per-command timeout in seconds for test commands. Default 300. */
  test_timeout_sec: number;
  /** Max RSS in MB for any single test command subprocess. 0 = disabled. Default 0. */
  test_max_rss_mb: number;
  /** Stop running subsequent test commands after the first failure. Default true. */
  test_fail_fast: boolean;
  /** Structured report format the project's `test:` commands write. Only 'junit-xml' is supported (native to both pytest and vitest). Undefined = no structured report. */
  test_report_format?: 'junit-xml';
  /** Glob matched once after every `test:` command finishes, collecting every matching report file into one normalized result. Applies globally across the whole test: list, not per-command. */
  test_report_glob: string;
  /**
   * Diff-scoped alternative to `test:`, run instead of it when the requesting
   * session's diff touches none of `test_full_run_paths`. May contain
   * `{{changed_files}}` (same templating as `autofix` — see
   * expandAutofixCommand in autofix-runner.ts), expanded against the
   * session's changed files. Empty = feature off (always run `test:`,
   * today's behavior unchanged).
   */
  test_scoped: string[];
  /**
   * Glob list (minimatch, matched against `git diff --name-only
   * <baseBranch>...HEAD` paths via matchesPathDiff) that forces the full
   * `test:` command instead of `test_scoped` when the session's diff
   * touches any of them — e.g. shared config/infra files a scoped run
   * can't safely skip. Ignored when `test_scoped` is empty.
   */
  test_full_run_paths: string[];
  /** Commands the orchestrator runs as static analysis gate, between verify and test. Empty = gate skipped. */
  analyze: AnalyzeCommand[];
  /** Per-command timeout in seconds for analyze commands. Default 300. */
  analyze_timeout_sec: number;
  /** Max RSS in MB for any single analyze command subprocess. 0 = disabled. Default 0. */
  analyze_max_rss_mb: number;
  /** Stop running subsequent analyze commands after the first failure. Default true. */
  analyze_fail_fast: boolean;
  /**
   * When true, orchestrator autofix and file-revert commits include [skip ci]
   * so GitHub skips pull_request workflows, saving CI minutes. Defaults to
   * false: on projects with required GitHub status checks, [skip ci] prevents
   * those checks from reporting, permanently blocking the PR. Opt in only on
   * projects confirmed to have no required status checks on the base branch.
   */
  autofix_skip_ci: boolean;
  /**
   * Lockfile path(s) (relative to project root) that key the dependency-cache
   * fast-path lookup hash for the governed test lane's per-session worktree
   * bootstrap (e.g. `['package-lock.json']` for npm, `['uv.lock']` for uv).
   * Empty = dependency-cache pooling opt-out (default).
   */
  dependency_lock_paths: string[];
  /**
   * Untracked directories (relative to project root) that `bootstrap_script`
   * populates and that should be cached/restored across sessions (e.g.
   * `['node_modules']`, `['.venv']`). May list more than one entry in a
   * workspace layout. Empty = dependency-cache pooling opt-out (default).
   */
  dependency_cache_dirs: string[];
  /**
   * Project-authored command that exits zero iff the currently-materialized
   * `dependency_cache_dirs` content satisfies the current lockfile(s),
   * non-zero otherwise. Treated as the correctness gate on every cache hit —
   * a failure is treated exactly like a cache miss. The orchestrator never
   * interprets lockfile format or ecosystem itself; this command is the
   * project's own verification. Empty = no verify command (default).
   */
  dependency_verify_command: string;
  /**
   * Session-kind-keyed capability pre-grants, seeded directly into
   * `sessions.granted_capabilities` at spawn time (SessionManager.start,
   * via resolvePreGrantCapabilities/seedGrantedCapabilities) — before the
   * session's first turn, so a gate-verify/investigate/ops/groom/design/docs
   * session starts already holding the capability-shaped reads a project
   * always intends it to have, with no `session.requestCapability` round
   * trip needed. Each key is one of PRE_GRANT_SESSION_KINDS; each value is a
   * list of raw capability strings (e.g. `read:audit-log:<projectId>`).
   * Every resolved entry is still filtered through `isGrantable` before it's
   * written — this field cannot widen past the same ceiling an
   * operator-approved grant is held to. Missing/omitted = no pre-grants
   * (default).
   */
  capability_pre_grants: Partial<Record<PreGrantSessionKind, string[]>>;
  /**
   * This project's sanctioned read-only ad hoc DB query command, verbatim
   * as the capability string a dispatched session requests through
   * `session.requestCapability` (e.g. `'Bash(npx ts-node
   * packages/backend/scripts/adhoc-query.ts:*)'` for this repo, or a
   * project's own equivalent script). Read by
   * `planning/procedureAssembler.ts#renderAdHocReadCapability`, the single
   * shared source for the "no dedicated MCP read tool" DB-read paragraph
   * injected into every dispatched ops/gate-verify/investigate/deploy-step
   * session. Empty (default) = this project has not declared one; the
   * rendered paragraph falls back to a generic, project-agnostic version
   * that still routes through `session.requestCapability` rather than
   * naming a script that may not exist in this project's checkout.
   */
  ad_hoc_read_command: string;
}

const DEFAULTS: OrchestratorConfig = {
  autofix: [],
  verify: [],
  ci_check_name: [],
  allowed_tools: [],
  bash_rules: [],
  session_rules: [],
  review_rules: [],
  bootstrap_script: '',
  required_env: [],
  required_files: [],
  test: [],
  test_timeout_sec: 300,
  test_max_rss_mb: 0,
  test_fail_fast: true,
  test_report_format: undefined,
  test_report_glob: '',
  test_scoped: [],
  test_full_run_paths: [],
  analyze: [],
  analyze_timeout_sec: 300,
  analyze_max_rss_mb: 0,
  analyze_fail_fast: true,
  autofix_skip_ci: false,
  dependency_lock_paths: [],
  dependency_cache_dirs: [],
  dependency_verify_command: '',
  capability_pre_grants: {},
  ad_hoc_read_command: '',
};

function isPreGrantSessionKind(v: string): v is PreGrantSessionKind {
  return (PRE_GRANT_SESSION_KINDS as readonly string[]).includes(v);
}

function parseCapabilityPreGrants(
  raw: unknown,
): Partial<Record<PreGrantSessionKind, string[]>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULTS.capability_pre_grants;
  }
  const result: Partial<Record<PreGrantSessionKind, string[]>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPreGrantSessionKind(key) || !Array.isArray(value)) continue;
    result[key] = value.filter((v): v is string => typeof v === 'string');
  }
  return result;
}

function isValidAnalyzeEntry(v: unknown): v is AnalyzeCommand {
  if (typeof v === 'string') return true;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (typeof obj.command !== 'string') return false;
    if (
      obj.trigger_paths !== undefined &&
      !(
        Array.isArray(obj.trigger_paths) &&
        obj.trigger_paths.every((p) => typeof p === 'string')
      )
    ) {
      return false;
    }
    if (
      obj.transient_output_patterns !== undefined &&
      !(
        Array.isArray(obj.transient_output_patterns) &&
        obj.transient_output_patterns.every((p) => typeof p === 'string')
      )
    ) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Load per-project orchestrator configuration from `<projectDir>/.claude-orchestrator.yml`.
 * Falls back to empty defaults if the file does not exist or is invalid.
 * The file is read fresh on every call — no server restart needed to pick up changes.
 */
export function loadOrchestratorConfig(projectDir: string): OrchestratorConfig {
  const configPath = path.join(projectDir, '.claude-orchestrator.yml');
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULTS };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw) as Partial<OrchestratorConfig> | null;
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULTS };
    }
    return {
      autofix: Array.isArray(parsed.autofix)
        ? parsed.autofix
        : DEFAULTS.autofix,
      verify: Array.isArray(parsed.verify) ? parsed.verify : DEFAULTS.verify,
      ci_check_name: Array.isArray(parsed.ci_check_name)
        ? parsed.ci_check_name
        : DEFAULTS.ci_check_name,
      allowed_tools: Array.isArray(parsed.allowed_tools)
        ? parsed.allowed_tools
        : DEFAULTS.allowed_tools,
      bash_rules: Array.isArray(parsed.bash_rules)
        ? parsed.bash_rules
        : DEFAULTS.bash_rules,
      session_rules: Array.isArray(parsed.session_rules)
        ? parsed.session_rules
        : DEFAULTS.session_rules,
      review_rules: Array.isArray(parsed.review_rules)
        ? parsed.review_rules
        : DEFAULTS.review_rules,
      bootstrap_script:
        typeof parsed.bootstrap_script === 'string'
          ? parsed.bootstrap_script
          : DEFAULTS.bootstrap_script,
      required_env: Array.isArray(parsed.required_env)
        ? (parsed.required_env as unknown[])
            .filter((v) => typeof v === 'string')
            .map((v) => v as string)
        : DEFAULTS.required_env,
      required_files: Array.isArray(parsed.required_files)
        ? (parsed.required_files as unknown[])
            .filter((v) => typeof v === 'string')
            .map((v) => v as string)
        : DEFAULTS.required_files,
      test: Array.isArray(parsed.test) ? parsed.test : DEFAULTS.test,
      test_timeout_sec:
        typeof parsed.test_timeout_sec === 'number' &&
        Number.isFinite(parsed.test_timeout_sec) &&
        parsed.test_timeout_sec > 0
          ? parsed.test_timeout_sec
          : DEFAULTS.test_timeout_sec,
      test_max_rss_mb:
        typeof parsed.test_max_rss_mb === 'number' &&
        Number.isFinite(parsed.test_max_rss_mb) &&
        parsed.test_max_rss_mb >= 0
          ? parsed.test_max_rss_mb
          : DEFAULTS.test_max_rss_mb,
      test_fail_fast:
        typeof parsed.test_fail_fast === 'boolean'
          ? parsed.test_fail_fast
          : DEFAULTS.test_fail_fast,
      test_report_format:
        parsed.test_report_format === 'junit-xml'
          ? parsed.test_report_format
          : DEFAULTS.test_report_format,
      test_report_glob:
        typeof parsed.test_report_glob === 'string'
          ? parsed.test_report_glob
          : DEFAULTS.test_report_glob,
      test_scoped: Array.isArray(parsed.test_scoped)
        ? parsed.test_scoped
        : DEFAULTS.test_scoped,
      test_full_run_paths: Array.isArray(parsed.test_full_run_paths)
        ? parsed.test_full_run_paths
        : DEFAULTS.test_full_run_paths,
      analyze: Array.isArray(parsed.analyze)
        ? (parsed.analyze as unknown[]).filter(isValidAnalyzeEntry)
        : DEFAULTS.analyze,
      analyze_timeout_sec:
        typeof parsed.analyze_timeout_sec === 'number' &&
        Number.isFinite(parsed.analyze_timeout_sec) &&
        parsed.analyze_timeout_sec > 0
          ? parsed.analyze_timeout_sec
          : DEFAULTS.analyze_timeout_sec,
      analyze_max_rss_mb:
        typeof parsed.analyze_max_rss_mb === 'number' &&
        Number.isFinite(parsed.analyze_max_rss_mb) &&
        parsed.analyze_max_rss_mb >= 0
          ? parsed.analyze_max_rss_mb
          : DEFAULTS.analyze_max_rss_mb,
      analyze_fail_fast:
        typeof parsed.analyze_fail_fast === 'boolean'
          ? parsed.analyze_fail_fast
          : DEFAULTS.analyze_fail_fast,
      autofix_skip_ci:
        typeof parsed.autofix_skip_ci === 'boolean'
          ? parsed.autofix_skip_ci
          : DEFAULTS.autofix_skip_ci,
      dependency_lock_paths: Array.isArray(parsed.dependency_lock_paths)
        ? (parsed.dependency_lock_paths as unknown[])
            .filter((v) => typeof v === 'string')
            .map((v) => v as string)
        : DEFAULTS.dependency_lock_paths,
      dependency_cache_dirs: Array.isArray(parsed.dependency_cache_dirs)
        ? (parsed.dependency_cache_dirs as unknown[])
            .filter((v) => typeof v === 'string')
            .map((v) => v as string)
        : DEFAULTS.dependency_cache_dirs,
      dependency_verify_command:
        typeof parsed.dependency_verify_command === 'string'
          ? parsed.dependency_verify_command
          : DEFAULTS.dependency_verify_command,
      capability_pre_grants: parseCapabilityPreGrants(
        parsed.capability_pre_grants,
      ),
      ad_hoc_read_command:
        typeof parsed.ad_hoc_read_command === 'string'
          ? parsed.ad_hoc_read_command
          : DEFAULTS.ad_hoc_read_command,
      mcp_servers:
        parsed.mcp_servers !== null &&
        typeof parsed.mcp_servers === 'object' &&
        !Array.isArray(parsed.mcp_servers)
          ? (parsed.mcp_servers as Record<string, unknown>)
          : undefined,
    };
  } catch (err) {
    logger.warn(
      `[orchestrator-config] failed to parse ${configPath}: ${err} — using defaults`,
    );
    return { ...DEFAULTS };
  }
}

/**
 * Capability strings a grant can never widen the allowlist with, regardless
 * of what an operator approved. Resolved/Done/task-intent-apply stay
 * device-authed — a session-scoped grant is not a substitute for that auth
 * boundary. No orchestrator MCP tool ever names an apply/resolve/Done
 * transition (the tool surface is staging + verdict-delivery + read-only
 * lookups only, see mcp/tools/stageProposalTools.ts,
 * mcp/tools/verdictTools.ts, and mcp/tools/architectureReadTools.ts — apply
 * lives solely on the device-authed /api/staged-intents REST surface), so
 * these patterns never need to special-case an `mcp__orchestrator__*` tool
 * name; a session may freely request a grant for any of them. Write/Edit
 * stay off ops/planning sessions entirely — file authorship is a Code task,
 * not something an operator grant can approve. Matched against the raw
 * granted-capability string.
 */
const GRANT_DENYLIST_PATTERNS = [
  /task-intent/i,
  /apply/i,
  /resolve/i,
  /done/i,
  /^Write$/i,
  /^Edit$/i,
  /^NotebookEdit$/i,
  /^MultiEdit$/i,
];

/**
 * Strips single- and double-quoted literal spans from a capability string
 * before it's tested against GRANT_DENYLIST_PATTERNS. A `Bash(...)`-shaped
 * capability's command verb sits outside any quotes; quoted spans are query
 * text / literal arguments (e.g. a `readonly-db-query.js "SELECT resolved_at
 * FROM ..."` capability) that can innocently contain "resolve"/"apply"/
 * "done"/"task-intent" as an ordinary word or column-name substring without
 * the capability itself resembling the mutating actions the denylist exists
 * to catch.
 */
function stripQuotedLiterals(capability: string): string {
  return capability.replace(/'[^']*'|"[^"]*"/g, '');
}

/**
 * Prefix for the grantable single-path filesystem-read capability: widens a
 * dispatched planning/ops session's read envelope (the `--add-dir` list
 * passed to the CLI, or the matching read-only bind mount in Docker mode —
 * see DockerSessionRunner) by exactly one absolute host path beyond its
 * per-session-type baseline (getSessionAddDirs below). Parameterized by the
 * literal path, like SESSION_RECORD_READ_PREFIX/AUDIT_LOG_READ_PREFIX below —
 * but unlike those id-parameterized prefixes, a granted path can legitimately
 * contain a denylisted substring (e.g. a directory named `.../apply-svc` or
 * `.../resolve-cache`), so `isGrantable` special-cases this prefix below
 * rather than scanning the whole capability string against
 * GRANT_DENYLIST_PATTERNS. Read-only: there is no write counterpart.
 */
const PATH_READ_PREFIX = 'read:path:';

export function isGrantable(capability: string): boolean {
  if (capability.startsWith(PATH_READ_PREFIX)) return true;
  const testable = stripQuotedLiterals(capability);
  return !GRANT_DENYLIST_PATTERNS.some((re) => re.test(testable));
}

/**
 * True when `capability` already matches GRANT_DENYLIST_PATTERNS — the
 * denylist-mining exclusion the capability-disposition-trail miner
 * (audit/capabilityDispositionMining.ts) checks before staging an
 * Investigation task for a repeated-denial pattern: a key the denylist
 * already covers needs no auto-deny candidate generated for it. The
 * logical negation of `isGrantable`, exported separately so the miner's
 * intent reads as "is this already denylisted" rather than reusing a
 * grant-time predicate for an unrelated exclusion check.
 */
export function isGrantDenylisted(capability: string): boolean {
  return !isGrantable(capability);
}

/**
 * Prefix for the one grantable own-record read capability: the
 * orchestrator's own runtime records (session_events + audit_log) for a
 * single named target session id, brokered via the `session.getRecord` MCP
 * tool (`mcp/tools/sessionRecordReadTool.ts`) — never a Bash-command prefix
 * or MCP verb, since the read reaches the orchestrator's own DB (outside a
 * dispatched session's worktree sandbox and its device-authed API) rather
 * than a tool this session's shell can already invoke. Read-only: there is
 * no write counterpart, and `isGrantable` never denies this prefix.
 */
const SESSION_RECORD_READ_PREFIX = 'read:session-record:';

/** Builds the exact capability string for reading one target session's own record. */
export function sessionRecordReadCapability(targetSessionId: string): string {
  return `${SESSION_RECORD_READ_PREFIX}${targetSessionId}`;
}

/** Extracts the target session id from a granted own-record-read capability, or null if it isn't one. */
export function parseSessionRecordReadCapability(
  capability: string,
): string | null {
  return capability.startsWith(SESSION_RECORD_READ_PREFIX)
    ? capability.slice(SESSION_RECORD_READ_PREFIX.length)
    : null;
}

/**
 * Prefix for the grantable project-scoped audit-log read capability: the
 * orchestrator's own `audit_log` table, filtered to one project id, exposed
 * via the `auditLog.query` MCP tool (see mcp/tools/auditLogReadTools.ts).
 * Mirrors SESSION_RECORD_READ_PREFIX's shape — parameterized by an id, never
 * a Bash-command prefix or bare MCP verb — but scoped to a project rather
 * than a single target session, since audit-log rows span every session and
 * human actor touching that project. Read-only: there is no write
 * counterpart, and `isGrantable` never denies this prefix.
 */
const AUDIT_LOG_READ_PREFIX = 'read:audit-log:';

/** Builds the exact capability string for querying one project's audit log. */
export function auditLogReadCapability(projectId: string): string {
  return `${AUDIT_LOG_READ_PREFIX}${projectId}`;
}

/** Extracts the target project id from a granted audit-log-read capability, or null if it isn't one. */
export function parseAuditLogReadCapability(capability: string): string | null {
  return capability.startsWith(AUDIT_LOG_READ_PREFIX)
    ? capability.slice(AUDIT_LOG_READ_PREFIX.length)
    : null;
}

/**
 * Prefix for the grantable project-scoped session-events read capability:
 * an aggregate-first read over the orchestrator's own `session_events`
 * table across every session in one project, exposed via the
 * `sessionEvents.query` MCP tool (see
 * mcp/tools/sessionEventsReadTools.ts). Mirrors AUDIT_LOG_READ_PREFIX's
 * shape and authorization rule exactly — parameterized by project id, own-
 * project auto-approves, any other project's grant parks for operator
 * approval — since session_events content is the same class of "another
 * session's attributed actions" data as audit_log, just aggregated across
 * sessions instead of read one session at a time (see
 * SESSION_RECORD_READ_PREFIX). Read-only: there is no write counterpart,
 * and `isGrantable` never denies this prefix.
 */
const SESSION_EVENTS_READ_PREFIX = 'read:session-events:';

/** Builds the exact capability string for querying one project's session_events. */
export function sessionEventsReadCapability(projectId: string): string {
  return `${SESSION_EVENTS_READ_PREFIX}${projectId}`;
}

/** Extracts the target project id from a granted session-events-read capability, or null if it isn't one. */
export function parseSessionEventsReadCapability(
  capability: string,
): string | null {
  return capability.startsWith(SESSION_EVENTS_READ_PREFIX)
    ? capability.slice(SESSION_EVENTS_READ_PREFIX.length)
    : null;
}

/** Builds the exact capability string for reading one additional absolute host path. */
export function pathReadCapability(absPath: string): string {
  return `${PATH_READ_PREFIX}${absPath}`;
}

/** Extracts the granted absolute path from a `read:path:` capability, or null if it isn't one. */
export function parsePathReadCapability(capability: string): string | null {
  return capability.startsWith(PATH_READ_PREFIX)
    ? capability.slice(PATH_READ_PREFIX.length)
    : null;
}

/**
 * Resolves a spawn's `sessionType` + `taskId` to the pre-grant session kind
 * whose `.claude-orchestrator.yml` `capability_pre_grants` entry applies —
 * mirroring how isGateVerifySession/isInvestigateSession derive their two
 * sessionType-'ops' sub-kinds from the task_id prefix. Returns null for a
 * sessionType with no pre-grant key (standard/review/split/depth_review).
 */
export function resolvePreGrantSessionKind(
  sessionType: string,
  taskId: string | null | undefined,
): PreGrantSessionKind | null {
  if (sessionType === 'ops') {
    if (isGateVerifySession(taskId)) return 'gate-verify';
    if (isInvestigateSession(taskId)) return 'investigate';
    return 'ops';
  }
  if (
    sessionType === 'groom' ||
    sessionType === 'design' ||
    sessionType === 'docs'
  ) {
    return sessionType;
  }
  return null;
}

/**
 * The resolved, `isGrantable`-filtered capability list a spawn should be
 * seeded with — see OrchestratorConfig.capability_pre_grants's doc comment
 * for the write path (SessionManager.start ->
 * db/queries.ts#seedGrantedCapabilities). Returns `[]` for a sessionType with
 * no pre-grant key, an unconfigured key, or when every configured entry is
 * denylisted.
 */
export function resolvePreGrantCapabilities(
  orchConfig: Pick<OrchestratorConfig, 'capability_pre_grants'>,
  sessionType: string,
  taskId: string | null | undefined,
): string[] {
  const kind = resolvePreGrantSessionKind(sessionType, taskId);
  if (kind === null) return [];
  const configured = orchConfig.capability_pre_grants[kind] ?? [];
  return configured.filter(isGrantable);
}

/**
 * Curated, operator-editable allowlist of sanctioned read-only capabilities
 * that `session.requestCapability` auto-approves without an operator park
 * (see stagedIntents.ts's auto-approve branch). Every entry must be an exact
 * capability string a grant can widen access with — never a Bash/mcp prefix
 * pattern, since a prefix cannot be certified read-only (sqlite3/node/python
 * can all write). Backed by the `capability_auto_approve_allowlist` runtime
 * setting (see config.ts/config/settings.ts/routes/settings.ts) — editable
 * live from the Settings UI rather than only via a source-level constant.
 * The only sanctioned capability shipped by default is the own-record reader
 * below, which is checked separately since it is parameterized by the
 * requesting session's own id rather than a fixed string.
 */
function sanctionedAutoApproveCapabilities(): readonly string[] {
  return runtimeSettings.capability_auto_approve_allowlist;
}

/**
 * True iff `capability` is exactly the sanctioned read-only capability set
 * for `requestingSessionId` — either a literal member of the
 * `capability_auto_approve_allowlist` runtime setting, the own-record-read
 * capability for the requesting session itself (never another session's; a
 * capability naming a different target session id is not a match, even
 * though it is grantable via the existing operator-approval path), or the
 * audit-log-read / session-events-read capability for the requesting
 * session's own dispatched project (`requestingProjectId` — never a
 * different project's, which parks for operator approval as usual).
 * Exact-string comparison only — never a prefix/heuristic match, so a
 * Bash(*:*) prefix or any other tool-shaped capability can never
 * auto-approve.
 *
 * The audit-log-read / session-events-read own-project auto-approve is
 * withheld from a `groom` session (`requestingSessionType`). Grooming's
 * mandate is validating a Backlog task's scope, size and dependencies from
 * the code and the board — no grooming judgement needs the orchestrator's own
 * operational record (session_events / audit_log), and that record is
 * exactly the investigation instrument a groom session should never
 * self-serve (see the worked instance this guards against: a groom session
 * auto-approved its own read:session-events grant, used it to run its target
 * Investigation to conclusion, then promoted the task to Ready). A groom
 * request for either capability now falls through to the ordinary
 * operator-park path instead. ops/design/gate-verify/investigate sessions
 * are unaffected — those flows are supposed to read the record — and the
 * own-record reader and the allowlist are untouched for every session type,
 * including groom.
 *
 * An investigate-dispatched session (`requestingTaskId` matching
 * sessionPredicates.ts#isInvestigateSession's `report-batch:` prefix) is
 * explicitly folded into the non-groom carve-out rather than left to pass it
 * incidentally by virtue of its sessionType staying 'ops' — the /investigate
 * skill's read-only-by-default posture makes this record exactly the
 * evidence an investigate session is dispatched to read (§ Evidence law:
 * "Session S did / didn't do Y" admits only its session_events transcript),
 * so this is named as a first-class case rather than relying on "not groom"
 * to cover it.
 */
export function isSanctionedAutoApproveCapability(
  capability: string,
  requestingSessionId: string,
  requestingProjectId?: string | null,
  requestingSessionType?: string | null,
  requestingTaskId?: string | null,
): boolean {
  const nonGroomCarveOut =
    requestingSessionType !== 'groom' || isInvestigateSession(requestingTaskId);
  return (
    capability === sessionRecordReadCapability(requestingSessionId) ||
    (requestingProjectId != null &&
      nonGroomCarveOut &&
      (capability === auditLogReadCapability(requestingProjectId) ||
        capability === sessionEventsReadCapability(requestingProjectId))) ||
    sanctionedAutoApproveCapabilities().includes(capability)
  );
}

/**
 * Stage-time auto-approve eligibility for a write-shaped
 * `session.requestCapability` request against the requesting ops session's
 * captured declared-writes set (see readinessGate.ts's DeclaredWriteEntry,
 * SessionManager.start's declaredWrites capture, and
 * db/queries.ts#getSessionDeclaredWrites). True iff `capability` exact-matches
 * a declared entry AND that entry is not tagged Prod-Mutating — never a
 * prefix/pattern match, and a Prod-Mutating-tagged entry (including one that
 * defaulted there for lack of an unambiguous tag — see
 * classifyProdMutatingTag) never auto-approves regardless of how confidently
 * it matches. This is purely additive: it narrows which already-`isGrantable`
 * requests skip manual approval, it never widens what's grantable — callers
 * must check `isGrantable(capability)` first (see
 * stagedIntents.ts#maybeAutoApproveCapabilityRequest).
 */
export function isDeclaredWriteAutoApprove(
  capability: string,
  declaredWrites: readonly { capability: string; prodMutating: boolean }[],
): boolean {
  const match = declaredWrites.find((e) => e.capability === capability);
  return match != null && !match.prodMutating;
}

/**
 * A granted capability shaped like an actual CLI tool permission — a Bash
 * command prefix or a named MCP verb. Only these widen `--allowed-tools` at
 * spawn (see `getSessionAllowedTools` below); the own-record-read,
 * audit-log-read, and session-events-read capabilities are checked directly
 * by the `session.getRecord` / `auditLog.query` / `sessionEvents.query` MCP
 * tool handlers against `getGrantedCapabilities`, not merged into the CLI
 * tool allowlist, since they name no tool the CLI resolves.
 */
export function isToolShapedCapability(capability: string): boolean {
  return capability.startsWith('Bash(') || capability.startsWith('mcp__');
}

/**
 * Command names whose Bash(...) capability, once granted, lets a session
 * overwrite or delete file content on disk — the same ground a bare `Edit`/
 * `Write` request covers, just reached through a shell verb the denylist
 * (GRANT_DENYLIST_PATTERNS above) does not spell against. Not a grantability
 * check: this list feeds `bashCapabilityConfersFileMutation` only, which is
 * advisory display, never `isGrantable`.
 */
const FILE_MUTATING_BASH_COMMANDS = [
  'sed',
  'perl',
  'awk',
  'tee',
  'dd',
  'truncate',
  'cp',
  'mv',
  'rm',
  'install',
  'patch',
  'tr',
  'chmod',
  'chown',
  'ln',
  'rsync',
  'sponge',
];

/**
 * True when a requested `Bash(...)` capability confers the ability to mutate
 * file contents — the equivalence a denied `Edit`/`Write` request and a
 * differently-spelled `Bash(...)` grant can share (e.g. `Bash(sed:*)` in
 * place of a refused `Edit`). Purely advisory: it never feeds `isGrantable`
 * and never blocks a grant, it only marks the staged intent so an approving
 * operator can see that a "run this command" request is also a
 * "write to any reachable file" request. Two signals: the command name (the
 * first token inside the parens, before any `:*` prefix wildcard or literal
 * argument) is a known file-mutating command, or the capability string
 * itself embeds a shell redirect (`>`/`>>`) onto a file.
 */
export function bashCapabilityConfersFileMutation(capability: string): boolean {
  if (!capability.startsWith('Bash(')) return false;
  const inner = capability.slice('Bash('.length).replace(/\)$/, '');
  if (inner.includes('>')) return true;
  const command = inner.trim().split(/[\s:]/, 1)[0];
  return FILE_MUTATING_BASH_COMMANDS.includes(command);
}

/**
 * The full allowlist a spawned session is granted. For code/review sessions
 * this is the base ALLOWED_TOOLS plus the per-project extras from
 * .claude-orchestrator.yml. Planning sessions (groom/design) get a dedicated,
 * stage-only/read-only tool set instead — per-project extras are never merged
 * in, since those may include mutating commands. ops sessions get a similar
 * stage-only/read-only base, but DO merge in the per-project extras from
 * .claude-orchestrator.yml — that's where a project's audited live-data read
 * surface (analyst MCP read verbs, read-only DB role, alarm/operational read
 * endpoints) is declared, and none of it is prod-mutating. This is the exact
 * array passed as `allowedTools` at spawn (see AgentSession) — extracted so
 * tests can assert on the merged result rather than just the base const.
 *
 * `granted` is the session's durable, operator-approved capability set (see
 * getGrantedCapabilities/addGrantedCapability in db/queries.ts) — composed
 * into every (re)spawn's allowlist as base ∪ granted, deduplicated. A grant
 * matching GRANT_DENYLIST_PATTERNS is dropped rather than merged in: the
 * mechanism widens tool access, never the resolved/apply/Done boundary.
 *
 * `taskSource` gates NOTION_READ_MCP_TOOLS into a planning session's
 * allow-list: only a Notion-task-source project's groom/design/ops sessions
 * get those entries, matching the notion MCP server only being registered
 * for Notion-sourced projects in SessionManager.ts#writeMcpConfig. A
 * Jira/GitHub/YAML project gets no Notion entries — granting them here
 * without the server being registered would be permissions for tools that
 * are structurally absent, the exact bug this gating fixes.
 *
 * `docsSourceDomains` is a docs session's per-dispatch WebFetch allowlist,
 * derived from the Docs task's declared Source domains (see the Docs
 * task-body convention). Only merged in for sessionType 'docs' — every other
 * session type ignores it. Never widens to an open WebFetch/WebSearch: an
 * empty/omitted list grants no WebFetch at all.
 *
 * `taskId` distinguishes an investigate-dispatched session from a plain ops
 * session: both spawn with sessionType 'ops' (see
 * sessionPredicates.ts#isInvestigateSession — no dedicated SessionType
 * literal exists for investigate), so the narrower INVESTIGATE_ALLOWED_TOOLS
 * envelope can only be selected by inspecting `taskId`'s `report-batch:`
 * prefix, ahead of the generic 'ops' branch below. Omitted (or a non-'ops'
 * sessionType) has no effect.
 */
export function getSessionAllowedTools(
  sessionType: string,
  orchConfig: Pick<OrchestratorConfig, 'allowed_tools'>,
  granted: string[] = [],
  taskSource?: 'notion' | 'yaml' | 'jira' | 'github',
  docsSourceDomains: string[] = [],
  taskId?: string | null,
): string[] {
  const grantable = granted.filter(isGrantable).filter(isToolShapedCapability);
  const notionExtras = taskSource === 'notion' ? NOTION_READ_MCP_TOOLS : [];
  const base =
    sessionType === 'groom'
      ? [...GROOM_ALLOWED_TOOLS, ...notionExtras]
      : sessionType === 'design'
        ? [...DESIGN_ALLOWED_TOOLS, ...notionExtras]
        : sessionType === 'ops' && isInvestigateSession(taskId)
          ? [
              ...INVESTIGATE_ALLOWED_TOOLS,
              ...notionExtras,
              ...orchConfig.allowed_tools,
            ]
          : sessionType === 'ops'
            ? [
                ...OPS_ALLOWED_TOOLS,
                ...notionExtras,
                ...orchConfig.allowed_tools,
              ]
            : sessionType === 'docs'
              ? [
                  ...DOCS_ALLOWED_TOOLS,
                  ...notionExtras,
                  ...docsWebFetchTools(docsSourceDomains),
                ]
              : sessionType === 'depth_review'
                ? [...DEPTH_REVIEW_ALLOWED_TOOLS, ...notionExtras]
                : [...ALLOWED_TOOLS, ...orchConfig.allowed_tools];
  return [...new Set([...base, ...grantable])];
}

/**
 * A test-runner ecosystem: `detect` identifies whether any configured test
 * command belongs to it (by its invoking package manager / interpreter),
 * `wrappers` are the ways that ecosystem's coarse `ALLOWED_TOOLS` entries
 * (`Bash(npm:*)`/`Bash(npx:*)`/`Bash(node:*)`, plus interpreters a project
 * may add via its own `allowed_tools`) let a runner be invoked directly, and
 * `runners` are that ecosystem's common test-runner CLI names. Only
 * wrappers that ride on a prefix already coarse-allowed (or plausibly
 * project-added, for the Python case) are listed — e.g. `yarn`/`pnpm` are
 * omitted since neither appears in `ALLOWED_TOOLS`, so a bare `Bash(yarn:*)`
 * call is already blocked by the allow-list, not by this deny layer.
 */
interface TestRunnerEcosystem {
  detect: RegExp;
  wrappers: string[];
  runners: string[];
}

const TEST_RUNNER_ECOSYSTEMS: TestRunnerEcosystem[] = [
  {
    detect: /^(npm|npx|node)\b/,
    wrappers: ['npx', 'npm exec'],
    runners: ['vitest', 'jest', 'mocha', 'ava', 'tap', 'jasmine'],
  },
  {
    detect: /^(uv|python3?|poetry|pytest)\b/,
    wrappers: ['uv run', 'python -m', 'python3 -m', 'poetry run'],
    runners: ['pytest'],
  },
];

/**
 * Argument-level SDK `permissions.deny` rules for a code session, derived
 * from the project's configured `test:` commands (OrchestratorConfig.test —
 * the same list test.request/testRequestLane.ts runs as the authoritative
 * test gate). A code session must not be able to run the project's tests
 * directly (see the "Flaky / Transient CI or F2 Gate Failures" section of
 * orchestrator-claudemd.ts, which routes it through test.request instead) —
 * this is what actually enforces that at the tool layer, rather than relying
 * on the injected instructions alone.
 *
 * Two layers of deny rule are generated:
 *
 * 1. Exact: each configured command becomes a `Bash(<command>:*)` prefix
 *    rule so trailing args (`-- --run`, extra flags) are still caught.
 * 2. Runner: a configured command like `npm run test -w packages/frontend`
 *    only denies that literal invocation, leaving the underlying test
 *    runner (vitest, resolved via the workspace's `package.json`, not
 *    visible here) reachable directly through the same coarse `npx`/`node`
 *    allow entries — `npx vitest run` runs the exact same suite without
 *    matching rule 1. TEST_RUNNER_ECOSYSTEMS closes that gap: once any
 *    configured command identifies a project as using an ecosystem (npm or
 *    Python), every common test-runner CLI in that ecosystem is denied
 *    across the wrapper forms (`npx <runner>`, `uv run <runner>`, bare
 *    `<runner>`, ...) that ride on already-allowed prefixes.
 *
 * Deliberately leaves the coarse `Bash(npm:*)`/`Bash(npx:*)`/`Bash(node:*)`/
 * `Bash(tsc:*)` allow entries in ALLOWED_TOOLS untouched — only the
 * specific runner binaries are denied, not the package managers themselves,
 * so install/build/typecheck commands keep working. Only meaningful for
 * `sessionType === 'standard'` (see isCodeSession) — callers should gate on
 * that before calling this with a non-empty list.
 */
export function getTestCommandDenyPatterns(testCommands: string[]): string[] {
  const trimmed = testCommands.map((cmd) => cmd.trim()).filter(Boolean);
  const exact = trimmed.map((cmd) => `Bash(${cmd}:*)`);

  const runnerPatterns: string[] = [];
  for (const eco of TEST_RUNNER_ECOSYSTEMS) {
    if (!trimmed.some((cmd) => eco.detect.test(cmd))) continue;
    for (const runner of eco.runners) {
      runnerPatterns.push(`Bash(${runner}:*)`);
      for (const wrapper of eco.wrappers) {
        runnerPatterns.push(`Bash(${wrapper} ${runner}:*)`);
      }
    }
  }

  return [...new Set([...exact, ...runnerPatterns])];
}

/**
 * Per-session-type baseline for the filesystem read envelope beyond a
 * dispatched session's own worktree — the `--add-dir` list passed to the CLI
 * (Docker mode: the matching set of read-only bind mounts on the `docker
 * run` invocation, since `--add-dir` inside the container only reaches
 * already-mounted paths — see DockerSessionRunner), unioned with any granted
 * `read:path:` capability (see PATH_READ_PREFIX above). Replaces the former
 * unconditional `--add-dir /` lift for every `isPlanningSession` type
 * (groom/design/ops/split/docs — and gate-verify, which dispatches as
 * sessionType 'ops'): every dispatched session ran as the same OS user, so
 * that blanket lift gave direct OS-level read access to every other
 * colocated project's secrets and to other sessions' scoped `.mcp.json`
 * credential files.
 *
 * The baseline is the central config tree's shared doc subpaths only — never
 * the config directory wholesale, since `remote-control.env`, `hooks/`, and
 * `systemd/` are credential-shaped siblings of `procedures.md`/
 * `task-writing.md` in that same tree. `projectDir` is the project checkout
 * root (== SessionRunnerOptions.worktreePath for a planning session, which
 * has no worktree of its own) — used both to resolve the central config tree
 * (resolveConfigDir) and, via its basename, as the per-project key under
 * `config/projects/<key>/`. A non-planning session type (standard/review)
 * gets no baseline at all — it stays confined to its worktree, same as
 * before this function existed.
 */
export function getSessionAddDirs(
  sessionType: string,
  granted: string[],
  projectDir: string,
): string[] {
  const baseline: string[] = [];
  if (isPlanningSession(sessionType)) {
    const configDir = resolveConfigDir(projectDir);
    if (configDir) {
      baseline.push(
        path.join(configDir, 'procedures.md'),
        path.join(configDir, 'task-writing.md'),
        path.join(configDir, 'README.md'),
        path.join(configDir, 'guidelines-baseline.json'),
      );
      const projectConfigDir = path.join(
        configDir,
        'projects',
        path.basename(projectDir),
      );
      baseline.push(
        path.join(projectConfigDir, 'context.md'),
        path.join(projectConfigDir, 'investigation-guide.md'),
        path.join(projectConfigDir, 'grooming.json'),
      );
    }
  }
  const grantedPaths = granted
    .map(parsePathReadCapability)
    .filter((p): p is string => p !== null);
  return [...new Set([...baseline, ...grantedPaths])];
}
