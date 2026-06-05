import { Router } from 'express';
import type { RequestHandler } from 'express';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DataDirConfigSource } from '../config/DataDirConfigSource';
import { countProjects } from '../db/queries';
import type { DeepPartial, OrchestratorConfig } from '../config/types';
import { GitHubClient } from '../github/GitHubClient';
import { GitHubApiError } from '../github/types';
import { probeNotionToken } from '../notion/NotionClient';
import { NotionApiError } from '../notion/types';

const router = Router();

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/setup/status', (_req, res) => {
  const src = new DataDirConfigSource();
  const cfg = src.read();
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

  res.json({ setupNeeded: missing.length > 0, missing });
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

function claudeCredentialsPath(): string {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? os.homedir(),
      'Claude',
      '.credentials.json',
    );
  }
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

function isClaudeAuthenticated(): boolean {
  const credPath = claudeCredentialsPath();
  if (!fs.existsSync(credPath)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf8')) as Record<
      string,
      unknown
    >;
    // Credentials file has a non-empty token when authenticated
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
      return { valid: false, message: `GitHub API error: ${err.statusCode}` };
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

router.post('/setup/validate', async (req, res) => {
  const { type, token } = req.body as { type?: string; token?: string };
  if (type !== 'github' && type !== 'notion') {
    res.status(400).json({ error: 'type must be "github" or "notion"' });
    return;
  }
  if (typeof token !== 'string' || !token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  const result =
    type === 'github'
      ? await validateGitHubToken(token)
      : await validateNotionToken(token);

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

router.post('/setup/import', (req, res) => {
  const { path: envPath } = req.body as { path?: string };
  if (typeof envPath !== 'string' || !envPath) {
    res.status(400).json({ error: 'path is required' });
    return;
  }

  if (!fs.existsSync(envPath)) {
    res.status(404).json({ error: `File not found: ${envPath}` });
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    res.status(500).json({ error: `Failed to read file: ${String(err)}` });
    return;
  }

  const parsed = parseEnvFile(content);
  const src = new DataDirConfigSource();
  const imported: string[] = [];

  for (const [key, mapper] of Object.entries(ENV_KEY_MAP)) {
    if (key in parsed && parsed[key]) {
      const partial = mapper(parsed[key]);
      src.write(partial);
      // Collect the dotted config key(s) imported
      const section = Object.keys(partial)[0] as keyof OrchestratorConfig;
      const fields = Object.keys(partial[section] as object);
      for (const field of fields) {
        imported.push(`${section}.${field}`);
      }
    }
  }

  // Report if a sibling dashboard.db exists alongside the .env
  const siblingDb = path.join(path.dirname(envPath), 'dashboard.db');
  const dbFound = fs.existsSync(siblingDb);

  res.json({ imported, dbFound, dbPath: dbFound ? siblingDb : null });
});

export default router;

// ── Setup-mode guard ──────────────────────────────────────────────────────────

/**
 * Returns true when the backend is in "setup mode": config.json lacks a GitHub
 * token or no projects have been configured yet.
 */
export function isSetupRequired(): boolean {
  const src = new DataDirConfigSource();
  const cfg = src.read();
  if (!cfg.github.token) return true;
  try {
    if (countProjects() === 0) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * Express middleware that gates non-setup API routes when the backend is in
 * setup mode. Callers (e.g. the wizard UI) can always reach /api/setup/* and
 * /api/enrollment/*; everything else returns 503 until setup completes.
 */
export function createSetupModeGuard(): RequestHandler {
  return (req, res, next) => {
    if (
      req.path.startsWith('/setup') ||
      req.path.startsWith('/enrollment')
    ) {
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
