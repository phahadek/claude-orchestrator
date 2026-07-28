import { describe, it, expect } from 'vitest';
import { buildNotionMcpServerEntry } from '../notionMcpServer';

describe('buildNotionMcpServerEntry', () => {
  it('emits an env key that @notionhq/notion-mcp-server@2.5.1 actually reads (NOTION_TOKEN or OPENAPI_MCP_HEADERS), never NOTION_API_KEY', () => {
    const entry = buildNotionMcpServerEntry('secret_abc123') as {
      env: Record<string, string>;
    };
    const consumedKeys = ['NOTION_TOKEN', 'OPENAPI_MCP_HEADERS'];
    const emittedKeys = Object.keys(entry.env);

    expect(emittedKeys.some((k) => consumedKeys.includes(k))).toBe(true);
    expect(entry.env).not.toHaveProperty('NOTION_API_KEY');
  });

  it('inlines the resolved credential value, not a ${...} placeholder string', () => {
    const apiKey = 'secret_abc123';
    const entry = buildNotionMcpServerEntry(apiKey) as {
      env: Record<string, string>;
    };

    expect(entry.env.NOTION_TOKEN).toBe(apiKey);
    expect(entry.env.NOTION_TOKEN).not.toMatch(/\$\{.*\}/);
  });
});
