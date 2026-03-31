function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export interface ProjectConfig {
  name: string;
  contextUrl: string;
  boardId: string;
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

export const config = {
  notionApiKey: requireEnv('NOTION_API_KEY'),
  sqlitePath: process.env.DB_PATH ?? './dashboard.db',
  port: Number(process.env.PORT ?? 3000),
  projectDir: process.env.PROJECT_DIR ?? process.cwd(),
  projects: parseProjects(),
  claudePath: resolveClaudePath(),
};
