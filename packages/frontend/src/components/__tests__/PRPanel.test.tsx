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
    pauseReason: null,
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

  it('does not render Clear PRs button', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });

    render(<PRPanel activeProjectId="proj-1" />);

    await waitFor(() => {
      expect(screen.queryByText(/clear merged\/closed/i)).toBeNull();
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

describe('PRPanel — header layout', () => {
  function setupFetch() {
    (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes('/api/prs?'))
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    setupFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('desktop: header renders title and action buttons (regression)', async () => {
    render(<PRPanel activeProjectId="proj-1" onCollapse={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Open Pull Requests')).toBeDefined();
      expect(screen.getByRole('button', { name: /refresh/i })).toBeDefined();
      expect(screen.getByTitle('Collapse PR panel')).toBeDefined();
    });
  });

  it('mobile: action buttons are grouped in a container below the title', async () => {
    render(<PRPanel activeProjectId="proj-1" onCollapse={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText('Open Pull Requests')).toBeDefined(),
    );

    const title = screen.getByText('Open Pull Requests');
    const refreshBtn = screen.getByRole('button', { name: /refresh/i });

    // Buttons are wrapped in their own container (not direct siblings of the title)
    expect(refreshBtn.parentElement).not.toBe(title.parentElement);
    // Both share a common ancestor (headerBar)
    expect(title.parentElement?.contains(refreshBtn)).toBe(true);
  });

  it('Refresh button retains its click handler', async () => {
    render(<PRPanel activeProjectId="proj-1" />);
    await waitFor(() => screen.getByRole('button', { name: /refresh/i }));

    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    const callsBefore = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('Close button retains its click handler', async () => {
    const onCollapse = vi.fn();
    render(<PRPanel activeProjectId="proj-1" onCollapse={onCollapse} />);
    await waitFor(() => screen.getByTitle('Collapse PR panel'));

    fireEvent.click(screen.getByTitle('Collapse PR panel'));
    expect(onCollapse).toHaveBeenCalledOnce();
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

describe('PRPanel — differential routing (WorkItemCard vs PRHistoryRow)', () => {
  type MockFetch = ReturnType<typeof vi.fn>;

  function setupFetchWithPRs(prs: PRWorkItem[]) {
    (fetch as MockFetch).mockImplementation((url: string) => {
      if (url.includes('/api/prs?'))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => prs,
        });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    });
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes a merged PR with no active flags to PRHistoryRow (compact)', async () => {
    const mergedPR = makePR({
      prNumber: 10,
      title: 'Merged PR',
      state: 'merged',
      pauseReason: null,
      mergeState: null,
    });
    setupFetchWithPRs([mergedPR]);
    render(<PRPanel activeProjectId="proj-1" />);
    await waitFor(() => {
      // PRHistoryRow renders the title as a link — no WorkItemCard action buttons
      expect(screen.getByRole('link', { name: 'Merged PR' })).toBeDefined();
      expect(screen.queryByRole('button', { name: /run review/i })).toBeNull();
    });
  });

  it('routes a closed PR with no active flags to PRHistoryRow (compact)', async () => {
    const closedPR = makePR({
      prNumber: 11,
      title: 'Closed PR',
      state: 'closed',
      pauseReason: null,
      mergeState: null,
    });
    setupFetchWithPRs([closedPR]);
    render(<PRPanel activeProjectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Closed PR' })).toBeDefined();
      expect(screen.queryByRole('button', { name: /run review/i })).toBeNull();
    });
  });

  it('routes an open PR to WorkItemCard (full card)', async () => {
    const openPR = makePR({
      prNumber: 12,
      title: 'Open PR',
      state: 'open',
    });
    setupFetchWithPRs([openPR]);
    render(<PRPanel activeProjectId="proj-1" />);
    await waitFor(() => {
      // WorkItemCard renders review button for open PRs
      expect(screen.getByRole('button', { name: /run review/i })).toBeDefined();
    });
  });

  it('routes a merged PR with pauseReason set to WorkItemCard (not compact)', async () => {
    const pausedMergedPR = makePR({
      prNumber: 13,
      title: 'Paused Merged PR',
      state: 'merged',
      pauseReason: 'ci_billing_blocked',
    });
    setupFetchWithPRs([pausedMergedPR]);
    render(<PRPanel activeProjectId="proj-1" />);
    await waitFor(() => {
      // WorkItemCard is rendered — no link-only compact row
      expect(screen.getByText('Paused Merged PR')).toBeDefined();
      // Should not have a link (PRHistoryRow uses <a>) as the primary title element
      const titleEl = screen.getByText('Paused Merged PR');
      expect(titleEl.tagName.toLowerCase()).not.toBe('a');
    });
  });

  it('routes a merged PR with ci_failed mergeState to WorkItemCard (not compact)', async () => {
    const ciFailedMergedPR = makePR({
      prNumber: 14,
      title: 'CI Failed PR',
      state: 'merged',
      mergeState: 'ci_failed',
      pauseReason: null,
    });
    setupFetchWithPRs([ciFailedMergedPR]);
    render(<PRPanel activeProjectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByText('CI Failed PR')).toBeDefined();
      const titleEl = screen.getByText('CI Failed PR');
      expect(titleEl.tagName.toLowerCase()).not.toBe('a');
    });
  });

  it('open PR with pause_reason=ci_billing_blocked still renders WorkItemCard', async () => {
    const billingBlockedPR = makePR({
      prNumber: 15,
      title: 'Billing Blocked PR',
      state: 'open',
      pauseReason: 'ci_billing_blocked',
    });
    setupFetchWithPRs([billingBlockedPR]);
    render(<PRPanel activeProjectId="proj-1" />);
    await waitFor(() => {
      // WorkItemCard is rendered for open PRs regardless of pauseReason
      expect(screen.getByText('Billing Blocked PR')).toBeDefined();
      // No compact link
      expect(
        screen.queryByRole('link', { name: 'Billing Blocked PR' }),
      ).toBeNull();
    });
  });
});
