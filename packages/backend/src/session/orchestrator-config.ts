import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { logger } from '../logger';
import {
  ALLOWED_TOOLS,
  GROOM_ALLOWED_TOOLS,
  DESIGN_ALLOWED_TOOLS,
  OPS_ALLOWED_TOOLS,
} from '../config';

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
  /** Commands the orchestrator runs as static analysis gate, between verify and test. Empty = gate skipped. */
  analyze: string[];
  /** Per-command timeout in seconds for analyze commands. Default 300. */
  analyze_timeout_sec: number;
  /** Max RSS in MB for any single analyze command subprocess. 0 = disabled. Default 0. */
  analyze_max_rss_mb: number;
  /** Stop running subsequent analyze commands after the first failure. Default true. */
  analyze_fail_fast: boolean;
  /**
   * When true (default), orchestrator autofix and file-revert commits include
   * [skip ci] so GitHub skips pull_request workflows, saving CI minutes.
   * Set to false on projects with required GitHub status checks — [skip ci]
   * prevents those checks from reporting, permanently blocking the PR.
   */
  autofix_skip_ci: boolean;
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
  analyze: [],
  analyze_timeout_sec: 300,
  analyze_max_rss_mb: 0,
  analyze_fail_fast: true,
  autofix_skip_ci: true,
};

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
      analyze: Array.isArray(parsed.analyze)
        ? parsed.analyze
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
 * boundary. Write/Edit stay off ops/planning sessions entirely — file
 * authorship is a Code task, not something an operator grant can approve.
 * Matched against the raw granted-capability string.
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

export function isGrantable(capability: string): boolean {
  return !GRANT_DENYLIST_PATTERNS.some((re) => re.test(capability));
}

/**
 * Prefix for the one grantable own-record read capability: the
 * orchestrator's own runtime records (session_events + audit_log) for a
 * single named target session id, brokered loopback via
 * `routes/sessionRecordRead.ts` and the sanctioned
 * `read-session-record.mjs` client — never a Bash-command prefix or MCP
 * verb, since the read reaches the orchestrator's own DB (outside a
 * dispatched session's worktree sandbox and its device-authed API) rather
 * than a tool this session's shell can already invoke. Read-only: there is
 * no write counterpart, and `isGrantable` never denies this prefix.
 */
export const SESSION_RECORD_READ_PREFIX = 'read:session-record:';

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
 * A granted capability shaped like an actual CLI tool permission — a Bash
 * command prefix or a named MCP verb. Only these widen `--allowed-tools` at
 * spawn (see `getSessionAllowedTools` below); the own-record-read capability
 * is checked directly by `routes/sessionRecordRead.ts` against
 * `getGrantedCapabilities`, not merged into the CLI tool allowlist, since it
 * names no tool the CLI resolves.
 */
function isToolShapedCapability(capability: string): boolean {
  return capability.startsWith('Bash(') || capability.startsWith('mcp__');
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
 */
export function getSessionAllowedTools(
  sessionType: string,
  orchConfig: Pick<OrchestratorConfig, 'allowed_tools'>,
  granted: string[] = [],
): string[] {
  const grantable = granted.filter(isGrantable).filter(isToolShapedCapability);
  const base =
    sessionType === 'groom'
      ? [...GROOM_ALLOWED_TOOLS]
      : sessionType === 'design'
        ? [...DESIGN_ALLOWED_TOOLS]
        : sessionType === 'ops'
          ? [...OPS_ALLOWED_TOOLS, ...orchConfig.allowed_tools]
          : [...ALLOWED_TOOLS, ...orchConfig.allowed_tools];
  return [...new Set([...base, ...grantable])];
}
