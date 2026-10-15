import { describe, it, expect } from 'vitest';
import { buildNotionMcpServerEntry } from '../notionMcpServer';

describe('buildNotionMcpServerEntry', () => {
  const entry = buildNotionMcpServerEntry(4321, 'stage-token-abc') as {
    env: Record<string, string>;
  };

  it('points BASE_URL at the loopback read-only proxy', () => {
    expect(entry.env.BASE_URL).toBe('http://127.0.0.1:4321/api/notion-proxy');
  });

  it('carries the stage credential as a bearer in OPENAPI_MCP_HEADERS', () => {
    expect(JSON.parse(entry.env.OPENAPI_MCP_HEADERS)).toEqual({
      Authorization: 'Bearer stage-token-abc',
    });
  });

  it('never carries NOTION_TOKEN or NOTION_API_KEY', () => {
    expect(entry.env).not.toHaveProperty('NOTION_TOKEN');
    expect(entry.env).not.toHaveProperty('NOTION_API_KEY');
  });
});
