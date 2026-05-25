import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PRPanel } from '../PRPanel';
import type { PRWorkItem } from '../WorkItemCard';

function makePR(overrides: Partial<PRWorkItem> = {}): PRWorkItem {
  return {
    type: 'pr',
    prNumber: 1,
    prUrl: 'https://github.com/owner/repo/pull/1',
    repo: 'owner/repo',
    title: 'My PR',
    headBranch: 'feature/foo',
    branchName: 'feature/foo',
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
    mergeState: null,
    autoMergeEnabled: false,
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

    render(<PRPanel activeProjectId="proj-1" />);

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

    render(<PRPanel activeProjectId="proj-1" />);

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

    render(<PRPanel activeProjectId="proj-no-repo" />);

    await waitFor(() => {
      expect(screen.getByText(/no github repo configured/i)).toBeDefined();
    });
  });

  it('shows network error banner on fetch failure', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error'),
    );

    render(<PRPanel activeProjectId="proj-1" />);

    await waitFor(() => {
      expect(screen.getByText(/could not reach server/i)).toBeDefined();
    });
  });
});

describe('PRPanel — inflight state cleared by WS events', () => {
  type MockFetch = ReturnType<typeof vi.fn>;

  function setupFetch(
    prs: PRWorkItem[],
    actionMatcher: (url: string, opts?: RequestInit) => boolean,
    actionPromise: Promise<unknown>,
  ) {
    (fetch as MockFetch).mockImplementation(
      (url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/prs?')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => prs,
          });
        }
        if (typeof url === 'string' && url.includes('clear/count')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ count: 0 }),
          });
        }
        if (actionMatcher(url as string, opts)) {
          return actionPromise;
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        });
      },
    );
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clears reviewInFlight when prReviewEvent arrives', async () => {
    const pr = makePR({ prNumber: 1, reviewResult: null, sessionId: null });
    const reviewPending = new Promise(() => {});
    setupFetch([pr], (url) => url.includes('/review'), reviewPending);

    const { rerender } = render(
      <PRPanel activeProjectId="proj-1" prReviewEvent={null} />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /run review/i })).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: /run review/i }));
    await waitFor(() => expect(screen.getByText(/reviewing/i)).toBeDefined());

    rerender(
      <PRPanel
        activeProjectId="proj-1"
        prReviewEvent={{ prNumber: 1, verdict: 'approved', summary: 'ok' }}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/reviewing/i)).toBeNull());
  });

  it('HTTP finally block still clears reviewInFlight as defense-in-depth', async () => {
    const pr = makePR({ prNumber: 1, reviewResult: null, sessionId: null });
    let resolveReview!: (v: unknown) => void;
    const reviewPending = new Promise((r) => {
      resolveReview = r;
    });
    setupFetch([pr], (url) => url.includes('/review'), reviewPending);

    render(<PRPanel activeProjectId="proj-1" prReviewEvent={null} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /run review/i })).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: /run review/i }));
    await waitFor(() => expect(screen.getByText(/reviewing/i)).toBeDefined());

    resolveReview({ ok: true, status: 200, json: async () => ({}) });
    await waitFor(() => expect(screen.queryByText(/reviewing/i)).toBeNull());
  });

  it('clears mergeInFlight when prMergedEvent arrives', async () => {
    const pr = makePR({
      prNumber: 1,
      state: 'open',
      reviewResult: { verdict: 'approved', summary: '' },
      mergeState: null,
    });
    const mergePending = new Promise(() => {});
    (fetch as MockFetch).mockImplementation(
      (url: string, opts?: RequestInit) => {
        if (url.includes('/api/prs?'))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [pr],
          });
        if (url.includes('clear/count'))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ count: 0 }),
          });
        if (url.endsWith('/mergeability'))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ mergeable: null, mergeState: null }),
          });
        if (url.endsWith('/merge') && opts?.method === 'POST')
          return mergePending;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        });
      },
    );

    const { rerender } = render(
      <PRPanel activeProjectId="proj-1" prMergedEvent={null} />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /merge/i })).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: /merge/i }));
    await waitFor(() => expect(screen.getByText(/merging/i)).toBeDefined());

    rerender(
      <PRPanel
        activeProjectId="proj-1"
        prMergedEvent={{ prNumber: 1, repo: 'owner/repo', sha: 'abc123' }}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/merging/i)).toBeNull());
  });

  it('clears removeInFlight when prClosedEvent arrives', async () => {
    const pr = makePR({ prNumber: 1 });
    const removePending = new Promise(() => {});
    (fetch as MockFetch).mockImplementation(
      (url: string, opts?: RequestInit) => {
        if (url.includes('/api/prs?'))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [pr],
          });
        if (url.includes('clear/count'))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ count: 0 }),
          });
        if (opts?.method === 'DELETE') return removePending;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        });
      },
    );

    const { rerender } = render(
      <PRPanel activeProjectId="proj-1" prClosedEvent={null} />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /✕/i })).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: /✕/i }));
    await waitFor(() => expect(screen.getByText('…')).toBeDefined());

    rerender(
      <PRPanel
        activeProjectId="proj-1"
        prClosedEvent={{ prNumber: 1, repo: 'owner/repo' }}
      />,
    );
    await waitFor(() => expect(screen.queryByText('…')).toBeNull());
  });

  it('clears approveInFlight when prStateChangedEvent arrives', async () => {
    const pr = makePR({ prNumber: 1, reviewResult: null, mergeState: null });
    const approvePending = new Promise(() => {});
    (fetch as MockFetch).mockImplementation(
      (url: string, opts?: RequestInit) => {
        if (url.includes('/api/prs?'))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [pr],
          });
        if (url.includes('clear/count'))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ count: 0 }),
          });
        if (url.includes('/approve') && opts?.method === 'POST')
          return approvePending;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        });
      },
    );

    const { rerender } = render(
      <PRPanel activeProjectId="proj-1" prStateChangedEvent={null} />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /approve/i })).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(screen.getByText(/approving/i)).toBeDefined());

    rerender(
      <PRPanel
        activeProjectId="proj-1"
        prStateChangedEvent={{
          prNumber: 1,
          repo: 'owner/repo',
          mergeable: true,
          mergeState: 'clean',
        }}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/approving/i)).toBeNull());
  });

  it('clears fixConflictsInFlight when prStateChangedEvent arrives', async () => {
    const pr = makePR({
      prNumber: 1,
      mergeState: 'dirty',
      reviewResult: null,
    });
    const fixPending = new Promise(() => {});
    (fetch as MockFetch).mockImplementation(
      (url: string, opts?: RequestInit) => {
        if (url.includes('/api/prs?'))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [pr],
          });
        if (url.includes('clear/count'))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ count: 0 }),
          });
        if (url.includes('/fix-conflicts') && opts?.method === 'POST')
          return fixPending;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        });
      },
    );

    const { rerender } = render(
      <PRPanel activeProjectId="proj-1" prStateChangedEvent={null} />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /fix conflicts/i }),
      ).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: /fix conflicts/i }));
    await waitFor(() => expect(screen.getByText(/fixing/i)).toBeDefined());

    rerender(
      <PRPanel
        activeProjectId="proj-1"
        prStateChangedEvent={{
          prNumber: 1,
          repo: 'owner/repo',
          mergeable: true,
          mergeState: 'clean',
        }}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/fixing/i)).toBeNull());
  });

  it('clears checkingMergeability when prMergeabilityChangedEvent arrives', async () => {
    const pr = makePR({
      prNumber: 1,
      state: 'open',
      reviewResult: { verdict: 'approved', summary: '' },
      mergeState: null,
    });
    const mergeabilityPending = new Promise(() => {});
    (fetch as MockFetch).mockImplementation((url: string) => {
      if (url.includes('/api/prs?'))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [pr],
        });
      if (url.includes('clear/count'))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ count: 0 }),
        });
      if (url.endsWith('/mergeability')) return mergeabilityPending;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    });

    const { rerender } = render(
      <PRPanel activeProjectId="proj-1" prMergeabilityChangedEvent={null} />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /merge/i })).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: /merge/i }));
    await waitFor(() =>
      expect(screen.getByText(/checking mergeability/i)).toBeDefined(),
    );

    rerender(
      <PRPanel
        activeProjectId="proj-1"
        prMergeabilityChangedEvent={{
          prNumber: 1,
          repo: 'owner/repo',
          mergeable: true,
          mergeState: 'clean',
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByText(/checking mergeability/i)).toBeNull(),
    );
  });
});

describe('PRPanel — per-card ErrorBoundary isolation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence React's logged error */
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.doUnmock('../WorkItemCard');
    vi.resetModules();
  });

  it('a throw inside one WorkItemCard does not crash PRPanel; other cards still render', async () => {
    const prs = [
      makePR({ prNumber: 1, title: 'PR One' }),
      makePR({ prNumber: 2, title: 'Broken PR' }),
      makePR({ prNumber: 3, title: 'PR Three' }),
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => prs,
    });

    vi.resetModules();
    vi.doMock('../WorkItemCard', () => ({
      WorkItemCard: ({ item }: { item: PRWorkItem }) => {
        if (item.type === 'pr' && item.prNumber === 2) throw new Error('boom');
        return <div data-testid={`pr-${item.prNumber}`}>{item.title}</div>;
      },
    }));

    const { PRPanel: PRPanelIsolated } = await import('../PRPanel');

    render(<PRPanelIsolated activeProjectId="proj-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('pr-1')).toBeDefined();
      expect(screen.getByTestId('pr-3')).toBeDefined();
    });
    expect(screen.queryByTestId('pr-2')).toBeNull();
    expect(screen.getByText(/pr card failed to render/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });
});
