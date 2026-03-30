function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  notionApiKey: requireEnv('NOTION_API_KEY'),
  sqlitePath: process.env.DB_PATH ?? './dashboard.db',
  port: Number(process.env.PORT ?? 3000),
};
