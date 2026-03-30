import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('GET /api/config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns parsed PROJECTS array from env', async () => {
    const projects = [
      { name: 'Test Project', contextUrl: 'https://notion.so/abc', boardId: 'board-1' },
    ];
    vi.stubEnv('PROJECTS', JSON.stringify(projects));
    vi.stubEnv('NOTION_API_KEY', 'test-key');

    const { config } = await import('../config');
    expect(config.projects).toEqual(projects);
  });

  it('falls back to empty array when PROJECTS is missing', async () => {
    delete process.env.PROJECTS;
    vi.stubEnv('NOTION_API_KEY', 'test-key');

    const { config } = await import('../config');
    expect(config.projects).toEqual([]);
  });

  it('falls back to empty array and logs error when PROJECTS is malformed JSON', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('PROJECTS', '{not valid json');
    vi.stubEnv('NOTION_API_KEY', 'test-key');

    const { config } = await import('../config');
    expect(config.projects).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[config] Failed to parse PROJECTS env var:',
      expect.any(SyntaxError),
    );
    consoleSpy.mockRestore();
  });
});
