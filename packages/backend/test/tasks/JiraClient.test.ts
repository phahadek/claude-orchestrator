import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraClient, JiraApiError } from '../../src/tasks/JiraClient.js';

// ── fetch mock ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeIssue(key: string, status = 'To Do') {
  return {
    id: '10001',
    key,
    fields: {
      summary: `Summary of ${key}`,
      status: { name: status },
      issuetype: { name: 'Task' },
      priority: { name: 'Medium' },
      description: null,
    },
  };
}

// ── JiraClient.buildReadyJql ──────────────────────────────────────────────────

describe('JiraClient.buildReadyJql', () => {
  it('builds a JQL with a single ready status', () => {
    const client = new JiraClient('https://example.atlassian.net', 'tok');
    const jql = client.buildReadyJql('PROJ', ['To Do']);
    expect(jql).toContain('project = "PROJ"');
    expect(jql).toContain('"To Do"');
    expect(jql).toContain('status in');
  });

  it('builds a JQL with multiple ready statuses', () => {
    const client = new JiraClient('https://example.atlassian.net', 'tok');
    const jql = client.buildReadyJql('ABC', ['To Do', 'Ready']);
    expect(jql).toContain('"To Do"');
    expect(jql).toContain('"Ready"');
  });

  it('includes ORDER BY priority DESC', () => {
    const client = new JiraClient('https://example.atlassian.net', 'tok');
    const jql = client.buildReadyJql('X', ['Open']);
    expect(jql).toMatch(/ORDER BY priority DESC/i);
  });
});

// ── JiraClient.searchIssues ───────────────────────────────────────────────────

describe('JiraClient.searchIssues', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns all issues from a single page response', async () => {
    const client = new JiraClient('https://example.atlassian.net', 'tok');
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        issues: [makeIssue('PROJ-1'), makeIssue('PROJ-2')],
        total: 2,
        maxResults: 100,
        startAt: 0,
      }),
    );

    const issues = await client.searchIssues('project = PROJ');
    expect(issues).toHaveLength(2);
    expect(issues[0].key).toBe('PROJ-1');
    expect(issues[1].key).toBe('PROJ-2');
  });

  it('uses bearer auth header when no email provided', async () => {
    const client = new JiraClient('https://example.atlassian.net', 'mytoken');
    mockFetch.mockResolvedValueOnce(
      mockResponse({ issues: [], total: 0, maxResults: 100, startAt: 0 }),
    );
    await client.searchIssues('project = X');
    const call = mockFetch.mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer mytoken');
  });

  it('uses basic auth when email is provided', async () => {
    const client = new JiraClient(
      'https://example.atlassian.net',
      'apitoken',
      'user@example.com',
    );
    mockFetch.mockResolvedValueOnce(
      mockResponse({ issues: [], total: 0, maxResults: 100, startAt: 0 }),
    );
    await client.searchIssues('project = X');
    const call = mockFetch.mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^Basic /);
    const decoded = Buffer.from(
      headers['Authorization'].slice(6),
      'base64',
    ).toString('utf8');
    expect(decoded).toBe('user@example.com:apitoken');
  });

  it('throws JiraApiError on non-2xx response', async () => {
    const client = new JiraClient('https://example.atlassian.net', 'tok');
    mockFetch.mockResolvedValueOnce(
      mockResponse({ message: 'Unauthorized' }, 401),
    );
    await expect(client.searchIssues('project = X')).rejects.toBeInstanceOf(
      JiraApiError,
    );
  });
});

// ── JiraClient.getTransitions ─────────────────────────────────────────────────

describe('JiraClient.getTransitions', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns transitions from the API', async () => {
    const client = new JiraClient('https://example.atlassian.net', 'tok');
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        transitions: [
          { id: '11', name: 'Start Progress', to: { name: 'In Progress' } },
          { id: '31', name: 'Done', to: { name: 'Done' } },
        ],
      }),
    );
    const transitions = await client.getTransitions('PROJ-1');
    expect(transitions).toHaveLength(2);
    expect(transitions[0].id).toBe('11');
    expect(transitions[0].to.name).toBe('In Progress');
  });
});
