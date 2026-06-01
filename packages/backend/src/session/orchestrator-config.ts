import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export interface OrchestratorConfig {
  /** Commands run in the worktree before opening the PR (mechanical fixes only). */
  autofix: string[];
  /** Commands the session runs before opening the PR (injected into CLAUDE.md). */
  verify: string[];
  /** GitHub check-run names treated as authoritative for pass/fail. */
  ci_check_name: string[];
  /** Extra Bash tool permission patterns merged with the base allowed-tools set. */
  allowed_tools: string[];
  /** Bash rules (Rule 5+). Each item is the full rule text. */
  bash_rules: string[];
  /** Path to a script run after worktree creation, relative to the project root. */
  bootstrap_script: string;
  /**
   * MCP server definitions to restrict sessions to. When defined, sessions only
   * see the listed MCP servers instead of inheriting all user-level servers.
   * Each key is the server name; value is the server config object.
   * Undefined = no override (all user-level servers are inherited).
   */
  mcp_servers?: Record<string, unknown>;
}

const DEFAULTS: OrchestratorConfig = {
  autofix: [],
  verify: [],
  ci_check_name: [],
  allowed_tools: [],
  bash_rules: [],
  bootstrap_script: '',
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
      bootstrap_script:
        typeof parsed.bootstrap_script === 'string'
          ? parsed.bootstrap_script
          : DEFAULTS.bootstrap_script,
      mcp_servers:
        parsed.mcp_servers !== null &&
        typeof parsed.mcp_servers === 'object' &&
        !Array.isArray(parsed.mcp_servers)
          ? (parsed.mcp_servers as Record<string, unknown>)
          : undefined,
    };
  } catch (err) {
    console.warn(
      `[orchestrator-config] failed to parse ${configPath}: ${err} — using defaults`,
    );
    return { ...DEFAULTS };
  }
}
