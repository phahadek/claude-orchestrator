import { Router } from 'express';
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getOrchestratorConfig,
  writeOrchestratorConfig,
} from '../config/appConfig';
import { claudeCredentialsPath } from '../config/credentialsPath';
import { getDataDir } from '../config/dataDir';
import { resolveDbPath } from '../config/resolveDbPath';
import { countProjects } from '../db/queries';
import type { DeepPartial, OrchestratorConfig } from '../config/types';
import { GitHubClient } from '../github/GitHubClient';
import { GitHubApiError } from '../github/types';
import { probeNotionToken } from '../notion/NotionClient';
import { NotionApiError } from '../notion/types';
import { JiraClient, JiraApiError } from '../tasks/JiraClient';
import { requireDeviceAuth, isLoopbackIp } from '../auth/DeviceAuth';

const router = Router();

// ── Access gate ──────────────────────────────────────────────────────────────

/**
 * Gates the setup routes on setup state and request origin.
 *
 * A fresh install with no credentials must be able to complete setup from
 * the machine itself, before any device token exists — so while setup is
 * genuinely pending, requests are restricted to loopback, mirroring the
 * enrollment-bootstrap window's isLoopbackIp check. Once setup has
 * completed, these are just another authenticated config-write surface —
 * required so credentials can be rotated without hand-editing config.json —
 * so they fall back to the normal device-auth check.
 */
export function requireSetupAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (getOrchestratorConfig().setupComplete) {
    requireDeviceAuth(req, res, next);
    return;
  }
  const remoteAddr = req.socket.remoteAddress ?? '';
  if (!isLoopbackIp(remoteAddr)) {
    res.status(403).json({ error: 'forbidden', code: 'setup_loopback_only' });
    return;
  }
  next();
}

router.use(requireSetupAccess);

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * Shared logic for setup status — used by both the /setup/status route and
 * isSetupRequired() so the two can never drift apart.
 *
 * missing[] lists all absent items for an informational Settings badge.
 * setupNeeded is true only on genuine first-run (setupComplete not yet set)
 * AND at least one hard requirement is absent (github.token or project).
 * notion.apiKey is optional and is reported in missing[] but never gates
 * the wizard by itself.
 */
export function computeSetupStatus(): {
  setupNeeded: boolean;
  missing: string[];
} {
  const cfg = getOrchestratorConfig();
  const missing: string[] = [];

  if (!cfg.github.token) missing.push('github.token');
  if (!cfg.notion.apiKey) missing.push('notion.apiKey');

  let projectCount = 0;
  try {
    projectCount = countProjects();
  } catch {
    // DB may not be initialized yet on very first boot
  }
  if (projectCount === 0) missing.push('project');

  if (cfg.setupComplete) return { setupNeeded: false, missing };

  const hardMissing = missing.filter((k) => k !== 'notion.apiKey');
  return { setupNeeded: hardMissing.length > 0, missing };
}

router.get('/setup/status', (_req, res) => {
  res.json(computeSetupStatus());
});

// ── Env check ─────────────────────────────────────────────────────────────────

function checkInstalled(cmd: string): boolean {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function isClaudeAuthenticated(credPathOverride?: string): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const credPath = credPathOverride ?? claudeCredentialsPath();
  if (!fs.existsSync(credPath)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf8')) as Record<
      string,
      unknown
    >;
    // Real shape: claudeAiOauth is an object bundle
    if (raw.claudeAiOauth && typeof raw.claudeAiOauth === 'object') return true;
    // Back-compat: older claudeAiOauthToken string
    return (
      typeof raw.claudeAiOauthToken === 'string' &&
      raw.claudeAiOauthToken.length > 0
    );
  } catch {
    return false;
  }
}

router.get('/setup/env-check', (_req, res) => {
  const claudeInstalled = checkInstalled('claude');
  const gitInstalled = checkInstalled('git');
  const claudeAuthenticated = claudeInstalled ? isClaudeAuthenticated() : false;

  res.json({ claudeInstalled, claudeAuthenticated, gitInstalled });
});

// ── Validate ──────────────────────────────────────────────────────────────────

async function validateGitHubToken(
  token: string,
): Promise<{ valid: boolean; message: string }> {
  try {
    const data = await GitHubClient.probe(token);
    return { valid: true, message: `Authenticated as ${data.login}` };
  } catch (err) {
    if (err instanceof GitHubApiError) {
      return { valid: false, message: `GitHub API error: ${err.status}` };
    }
    return { valid: false, message: `Request failed: ${String(err)}` };
  }
}

async function validateNotionToken(
  token: string,
): Promise<{ valid: boolean; message: string }> {
  try {
    const data = await probeNotionToken(token);
    return {
      valid: true,
      message: `Authenticated as ${data.name ?? data.type ?? 'unknown'}`,
    };
  } catch (err) {
    if (err instanceof NotionApiError) {
      return { valid: false, message: `Notion API error: ${err.statusCode}` };
    }
    return { valid: false, message: `Request failed: ${String(err)}` };
  }
}

async function validateJiraToken(
  host: string,
  token: string,
  email?: string,
): Promise<{ valid: boolean; message: string }> {
  try {
    const data = await JiraClient.probe(host, token, email);
    return {
      valid: true,
      message: `Authenticated as ${data.displayName ?? data.emailAddress ?? 'unknown'}`,
    };
  } catch (err) {
    if (err instanceof JiraApiError) {
      return { valid: false, message: `Jira API error: ${err.statusCode}` };
    }
    return { valid: false, message: `Request failed: ${String(err)}` };
  }
}

router.post('/setup/validate', async (req, res) => {
  const { type, token, host, email } = req.body as {
    type?: string;
    token?: string;
    host?: string;
    email?: string;
  };
  if (type !== 'github' && type !== 'notion' && type !== 'jira') {
    res
      .status(400)
      .json({ error: 'type must be "github", "notion", or "jira"' });
    return;
  }
  if (typeof token !== 'string' || !token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  if (type === 'jira' && (typeof host !== 'string' || !host)) {
    res.status(400).json({ error: 'host is required for jira validation' });
    return;
  }

  let result: { valid: boolean; message: string };
  if (type === 'github') {
    result = await validateGitHubToken(token);
  } else if (type === 'notion') {
    result = await validateNotionToken(token);
  } else {
    result = await validateJiraToken(host as string, token, email);
  }

  res.json(result);
});

// ── Import ────────────────────────────────────────────────────────────────────

const ENV_KEY_MAP: Record<
  string,
  (val: string) => DeepPartial<OrchestratorConfig>
> = {
  NOTION_API_KEY: (v) => ({ notion: { apiKey: v } }),
  GITHUB_TOKEN: (v) => ({ github: { token: v } }),
  GITHUB_REPO: (v) => ({ github: { repo: v } }),
  PORT: (v) => ({ server: { port: Number(v) } }),
  DB_PATH: (v) => ({ db: { path: v } }),
  SESSIONS_DIR: (v) => ({ sessions: { dir: v } }),
};

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    // Strip optional surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function isUnder(root: string, resolved: string): boolean {
  const rel = path.relative(path.resolve(root), resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Test-only override — lets tests substitute a controlled root without
// fighting Node's `os` module resolution (import os from 'os' resolves to a
// different interop wrapper per module, so mocking os.homedir at runtime
// doesn't reliably reach this module from a test file).
let envImportRootsOverride: string[] | null = null;
export function _setEnvImportRootsForTesting(roots: string[] | null): void {
  envImportRootsOverride = roots;
}

function permittedEnvRoots(): string[] {
  return envImportRootsOverride ?? [os.homedir(), getDataDir()];
}

/**
 * Bounds the .env import endpoint to files literally named ".env" that live
 * under the caller's home directory (where a legacy install's checkout
 * would live) or under this app's own data directory (e.g. a copy staged
 * there ahead of import). This is a caller-supplied filesystem path read
 * back into an HTTP response, so it's a file-disclosure surface independent
 * of who may call it — these are the widest bounds that still cover the
 * genuine use case.
 */
function isPermittedEnvPath(candidate: string): boolean {
  if (path.basename(candidate) !== '.env') return false;
  const resolved = path.resolve(candidate);
  return permittedEnvRoots().some((root) => isUnder(root, resolved));
}

router.post('/setup/import', (req, res) => {
  const { path: envPath } = req.body as { path?: string };
  if (typeof envPath !== 'string' || !envPath) {
    res.status(400).json({ error: 'path is required' });
    return;
  }

  if (!isPermittedEnvPath(envPath)) {
    res
      .status(400)
      .json({ error: 'path must be a .env file under your home directory' });
    return;
  }
  const resolved = path.resolve(envPath);

  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: `File not found: ${envPath}` });
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    res.status(500).json({ error: `Failed to read file: ${String(err)}` });
    return;
  }

  const parsed = parseEnvFile(content);
  const imported: string[] = [];

  for (const [key, mapper] of Object.entries(ENV_KEY_MAP)) {
    if (key in parsed && parsed[key]) {
      const partial = mapper(parsed[key]);
      writeOrchestratorConfig(partial);
      // Collect the dotted config key(s) imported
      const section = Object.keys(partial)[0] as keyof OrchestratorConfig;
      const fields = Object.keys(partial[section] as object);
      for (const field of fields) {
        imported.push(`${section}.${field}`);
      }
    }
  }

  // Report if a sibling dashboard.db exists alongside the .env
  const siblingDb = path.join(path.dirname(resolved), 'dashboard.db');
  const dbFound = fs.existsSync(siblingDb);

  res.json({ imported, dbFound, dbPath: dbFound ? siblingDb : null });
});

// ── Save credentials ──────────────────────────────────────────────────────────

router.post('/setup/save-credentials', (req, res) => {
  const { githubToken, notionApiKey } = req.body as {
    githubToken?: string;
    notionApiKey?: string;
  };
  const partial: DeepPartial<OrchestratorConfig> = {};
  if (typeof githubToken === 'string' && githubToken) {
    partial.github = { token: githubToken };
  }
  if (typeof notionApiKey === 'string' && notionApiKey) {
    partial.notion = { apiKey: notionApiKey };
  }
  writeOrchestratorConfig(partial);
  res.json({ ok: true });
});

// ── Complete / Skip ───────────────────────────────────────────────────────────

// Below this length a token/key is obviously a placeholder, not a real
// credential (the incident's github.token was "ghp-x", 5 characters).
const MIN_CREDENTIAL_LENGTH = 10;

function isPlaceholderRepo(repo: string): boolean {
  return repo.trim().toLowerCase() === 'owner/repo';
}

function isPlaceholderCredential(value: string): boolean {
  return value.trim().length > 0 && value.trim().length < MIN_CREDENTIAL_LENGTH;
}

function isDbDirWritable(resolvedDbPath: string): boolean {
  if (resolvedDbPath === ':memory:') return true;
  try {
    fs.accessSync(path.dirname(resolvedDbPath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates that the current config could actually start the service before
 * setupComplete is stamped. Skips fields that are simply unset (empty) —
 * only rejects values that are present but placeholder-shaped or unusable,
 * so a genuine first-run with partial config isn't blocked.
 */
function validateConfigForCompletion(): string[] {
  const cfg = getOrchestratorConfig();
  const problems: string[] = [];

  if (cfg.github.repo && isPlaceholderRepo(cfg.github.repo)) {
    problems.push('github.repo is still the placeholder value "owner/repo"');
  }
  if (cfg.github.token && isPlaceholderCredential(cfg.github.token)) {
    problems.push('github.token is too short to be a real token');
  }
  if (cfg.notion.apiKey && isPlaceholderCredential(cfg.notion.apiKey)) {
    problems.push('notion.apiKey is too short to be a real key');
  }

  const resolvedDbPath = resolveDbPath(
    cfg.db.path || './dashboard.db',
    getDataDir(),
  );
  if (!isDbDirWritable(resolvedDbPath)) {
    problems.push(
      `db.path resolves to "${resolvedDbPath}", whose directory is not writable`,
    );
  }

  return problems;
}

router.post('/setup/complete', (_req, res) => {
  const problems = validateConfigForCompletion();
  if (problems.length > 0) {
    res.status(400).json({ error: 'invalid_config', problems });
    return;
  }
  writeOrchestratorConfig({ setupComplete: true });
  res.json({ ok: true });
});

export default router;

// ── Setup-mode guard ──────────────────────────────────────────────────────────

/**
 * Returns true when the backend is in "setup mode".
 * Delegates to computeSetupStatus() so this function and /setup/status
 * always agree.
 */
export function isSetupRequired(): boolean {
  return computeSetupStatus().setupNeeded;
}

/**
 * Express middleware that gates non-setup API routes when the backend is in
 * setup mode. Callers (e.g. the wizard UI) can always reach /api/setup/* and
 * /api/enrollment/*; everything else returns 503 until setup completes.
 */
export function createSetupModeGuard(): RequestHandler {
  return (req, res, next) => {
    if (req.path.startsWith('/setup') || req.path.startsWith('/enrollment')) {
      return next();
    }
    if (isSetupRequired()) {
      res.status(503).json({
        error: 'setup_required',
        message:
          'Complete the first-run setup wizard before using the dashboard.',
      });
      return;
    }
    next();
  };
}
