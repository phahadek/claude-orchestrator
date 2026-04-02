function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export interface ProjectConfig {
  id: string;          // unique key, e.g. "claude-dashboard"
  name: string;
  projectDir: string;  // absolute path to the repo root
  contextUrl: string;
  boardId: string;
  githubRepo?: string; // "owner/repo" — optional; enables PR features
}

function parseProjects(): ProjectConfig[] {
  const raw = process.env.PROJECTS;
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ProjectConfig[];
  } catch (err) {
    console.error('[config] Failed to parse PROJECTS env var:', err);
    return [];
  }
}

function resolveClaudePath(): string {
  const explicit = process.env.CLAUDE_PATH;
  if (explicit) return explicit;
  // On Windows, spawn('claude', ..., { cwd }) fails if claude isn't in the
  // system PATH. Resolve the full path at startup so it always works.
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    return execSync(process.platform === 'win32' ? 'where claude' : 'which claude', {
      encoding: 'utf8',
    }).trim().split('\n')[0];
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

export const config = {
  notionApiKey: requireEnv('NOTION_API_KEY'),
  sqlitePath: process.env.DB_PATH ?? './dashboard.db',
  port: Number(process.env.PORT ?? 3000),
  projectDir: normalizePath(process.env.PROJECT_DIR ?? process.cwd()),
  projects: parseProjects(),
  claudePath: resolveClaudePath(),
  maxConcurrentSessions: Number(process.env.MAX_CONCURRENT_SESSIONS ?? 20),
};

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
export const GITHUB_REPO  = process.env.GITHUB_REPO  ?? '';  // "owner/repo"

export const ALLOWED_TOOLS = [
  'Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(tsc:*)',
  'Bash(gh:*)', 'Bash(cd:*)', 'Bash(which:*)', 'Bash(where:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(echo:*)', 'Bash(mkdir:*)',
  'Bash(cp:*)', 'Bash(mv:*)', 'Bash(head:*)', 'Bash(tail:*)',
  'Bash(wc:*)', 'Bash(find:*)', 'Bash(grep:*)', 'Bash(sort:*)',
  'Bash(pwd:*)',
  'mcp__claude_ai_Notion__*', 'mcp__github__*',
  'mcp__claude_ai_Asana__*', 'mcp__claude_ai_Google_Calendar__*',
];

export function getProjectById(id: string): ProjectConfig | undefined {
  return config.projects.find((p) => p.id === id);
}
