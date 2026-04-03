import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PRPanel } from '../PRPanel';
import type { PRListItem } from '../PRCard';

function makePR(overrides: Partial<PRListItem> = {}): PRListItem {
  return {
    prNumber: 1,
    prUrl: 'https://github.com/owner/repo/pull/1',
    repo: 'owner/repo',
    title: 'My PR',
    headBranch: 'feature/foo',
    baseBranch: 'dev',
    state: 'open',
    notionTaskId: null,
    notionTaskTitle: null,
    sessionId: null,
    reviewSessionId: null,
    reviewResult: null,
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('PRPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a card for each item returned by GET /api/prs', async () => {
    const prs = [
      makePR({ prNumber: 1, title: 'PR One' }),
      makePR({ prNumber: 2, title: 'PR Two' }),
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => prs,
    });

    render(<PRPanel activeProjectId="proj-1" onFixSession={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('PR One')).toBeDefined();
      expect(screen.getByText('PR Two')).toBeDefined();
    });
  });

  it('shows empty state when no PRs returned', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });

    render(<PRPanel activeProjectId="proj-1" onFixSession={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/no open pull requests/i)).toBeDefined();
    });
  });

  it('shows no-repo state when project has no githubRepo', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: 'Project has no githubRepo configured' }),
    });

    render(<PRPanel activeProjectId="proj-no-repo" onFixSession={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/no github repo configured/i)).toBeDefined();
    });
  });

  it('shows network error banner on fetch failure', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    render(<PRPanel activeProjectId="proj-1" onFixSession={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/could not reach server/i)).toBeDefined();
    });
  });
});
