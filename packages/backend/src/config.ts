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

export const config = {
  notionApiKey: requireEnv('NOTION_API_KEY'),
  sqlitePath: process.env.DB_PATH ?? './dashboard.db',
  port: Number(process.env.PORT ?? 3000),
  projectDir: process.env.PROJECT_DIR ?? process.cwd(),
  projects: parseProjects(),
};
