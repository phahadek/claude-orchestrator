// Thin REST wrapper for the Jira Cloud/Server v3 API.
// Supports bearer token (JIRA_TOKEN only) or basic auth (JIRA_EMAIL + JIRA_TOKEN).

interface JiraIssueFields {
  summary: string;
  status: { name: string };
  issuetype: { name: string };
  priority: { name: string } | null;
  description: string | { content?: unknown[] } | null;
  issuelinks?: Array<{
    type: { inward: string; outward: string };
    inwardIssue?: { key: string };
    outwardIssue?: { key: string };
  }>;
  parent?: { key: string };
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string };
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
  startAt: number;
}

interface JiraTransitionsResponse {
  transitions: JiraTransition[];
}

export class JiraApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(host: string, token: string, email?: string) {
    this.baseUrl = host.replace(/\/$/, '') + '/rest/api/3';
    if (email) {
      this.authHeader =
        'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
    } else {
      this.authHeader = `Bearer ${token}`;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new JiraApiError(res.status, `Jira API ${method} ${path}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  /** Build a JQL query string for issues matching given statuses. */
  buildReadyJql(projectKey: string, readyStatuses: string[]): string {
    const statuses = readyStatuses.map((s) => `"${s}"`).join(', ');
    return `project = "${projectKey}" AND status in (${statuses}) ORDER BY priority DESC`;
  }

  /** Build JQL for direct children of an Epic via the next-gen parent field. */
  buildEpicParentJql(epicKey: string): string {
    return `parent = "${epicKey}" ORDER BY priority DESC`;
  }

  /** Build JQL for direct children of an Epic via the classic Epic Link field. */
  buildEpicLinkJql(epicKey: string): string {
    return `"Epic Link" = "${epicKey}" ORDER BY priority DESC`;
  }

  /** Build JQL for sub-tasks whose parent is one of the given keys. */
  buildSubtaskJql(parentKeys: string[]): string {
    return `parent in (${parentKeys.map((k) => `"${k}"`).join(', ')}) ORDER BY priority DESC`;
  }

  /** Build JQL to fetch a batch of issues by key. */
  buildKeyInJql(keys: string[]): string {
    return `key in (${keys.map((k) => `"${k}"`).join(', ')})`;
  }

  /** Search issues using JQL, paginating through all results. */
  async searchIssues(jql: string): Promise<JiraIssue[]> {
    const all: JiraIssue[] = [];
    let startAt = 0;
    const maxResults = 100;

    let total = Infinity;
    while (all.length < total) {
      const resp = await this.request<JiraSearchResponse>('POST', '/search', {
        jql,
        startAt,
        maxResults,
        fields: [
          'summary',
          'status',
          'issuetype',
          'priority',
          'description',
          'issuelinks',
          'parent',
        ],
      });
      all.push(...resp.issues);
      total = resp.total;
      startAt += resp.issues.length;
      if (resp.issues.length === 0) break;
    }

    return all;
  }

  /** Fetch a single issue by key (e.g. PROJ-123). */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.request<JiraIssue>(
      'GET',
      `/issue/${issueKey}?fields=summary,status,issuetype,priority,description`,
    );
  }

  /** List available transitions for an issue. */
  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const resp = await this.request<JiraTransitionsResponse>(
      'GET',
      `/issue/${issueKey}/transitions`,
    );
    return resp.transitions;
  }

  /** Apply a transition by ID. */
  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.request<void>('POST', `/issue/${issueKey}/transitions`, {
      transition: { id: transitionId },
    });
  }

  /** Probe the Jira credentials by fetching the current user. */
  static async probe(
    host: string,
    token: string,
    email?: string,
  ): Promise<{ displayName: string; emailAddress?: string }> {
    const client = new JiraClient(host, token, email);
    return client.request<{ displayName: string; emailAddress?: string }>(
      'GET',
      '/myself',
    );
  }

  /** Add a plain-text comment to an issue. */
  async addComment(issueKey: string, text: string): Promise<void> {
    await this.request<unknown>('POST', `/issue/${issueKey}/comment`, {
      body: {
        version: 1,
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text }],
          },
        ],
      },
    });
  }
}
