import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyticsPanel } from '../AnalyticsPanel';
import { authedFetch, projectsApi } from '../../api/projects';
import type { ProjectMilestone } from '../../api/projects';

vi.mock('../../api/projects', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/projects')>(
      '../../api/projects',
    );
  return {
    ...actual,
    projectsApi: { listMilestones: vi.fn() },
    authedFetch: vi.fn(),
  };
});

function makeMilestone(
  overrides: Partial<ProjectMilestone> = {},
): ProjectMilestone {
  return {
    id: 'm1',
    projectId: 'p1',
    name: 'Milestone 1',
    sourceId: 'db-1',
    displayOrder: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const emptyTokensResponse = {
  range: { from: 0, to: 1 },
  taskRollups: [],
  sessionTypeBreakdown: [],
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    sessionCount: 0,
  },
};

const emptyTimeseriesResponse = {
  range: { from: 0, to: 1 },
  granularity: 'day',
  buckets: [],
};

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

const LONG_NAME = 'A'.repeat(40);

function tokensResponse() {
  return {
    range: { from: 0, to: 1 },
    taskRollups: [
      {
        boardId: 'board-alpha',
        taskId: 'notion:board-alpha',
        taskName: 'Alpha task',
        taskType: '💻 Code',
        sessionCount: 2,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCost: 5,
      },
      {
        boardId: 'board-beta',
        taskId: 'notion:board-beta',
        taskName: 'Beta task',
        taskType: '📐 Design',
        sessionCount: 5,
        inputTokens: 900,
        outputTokens: 400,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCost: 20,
      },
      {
        boardId: 'board-gamma',
        taskId: 'notion:board-gamma',
        taskName: LONG_NAME,
        taskType: null,
        sessionCount: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCost: 1,
      },
    ],
    sessionTypeBreakdown: [],
    totals: {
      inputTokens: 1010,
      outputTokens: 455,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 1465,
      totalCost: 26,
      sessionCount: 8,
    },
  };
}

function sessionsResponse() {
  return {
    sessions: [
      {
        sessionId: 'session-xyz-123',
        taskName: 'Alpha task',
        startedAt: 0,
        endedAt: 1,
        sessionType: 'standard',
        category: 'execution',
        model: 'claude-sonnet-4-6',
        inputTokens: 50,
        outputTokens: 25,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCost: 2.5,
      },
    ],
  };
}

describe('AnalyticsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectsApi.listMilestones).mockResolvedValue([
      makeMilestone({ id: 'm1', name: 'Milestone 1' }),
      makeMilestone({ id: 'm2', name: 'Milestone 2' }),
    ]);
    vi.mocked(authedFetch).mockImplementation((url) => {
      if (String(url).includes('/timeseries')) {
        return Promise.resolve(jsonResponse(emptyTimeseriesResponse));
      }
      return Promise.resolve(jsonResponse(emptyTokensResponse));
    });
  });

  describe('milestone and custom date range filters', () => {
    it('fetches the milestone list for the active project', async () => {
      render(<AnalyticsPanel activeProjectId="p1" />);
      await waitFor(() =>
        expect(projectsApi.listMilestones).toHaveBeenCalledWith('p1'),
      );
      await screen.findByText('All milestones');
      expect(screen.getByText('Milestone 1')).toBeTruthy();
      expect(screen.getByText('Milestone 2')).toBeTruthy();
    });

    it('re-fetches scoped to the selected milestone only', async () => {
      render(<AnalyticsPanel activeProjectId="p1" />);
      await waitFor(() =>
        expect(authedFetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/analytics/tokens?'),
        ),
      );
      vi.mocked(authedFetch).mockClear();

      const select = await screen.findByLabelText('Milestone');
      fireEvent.change(select, { target: { value: 'm2' } });

      await waitFor(() => {
        const calls = vi.mocked(authedFetch).mock.calls.map((c) => c[0]);
        expect(
          calls.some(
            (url) =>
              typeof url === 'string' &&
              url.includes('/api/analytics/tokens?') &&
              url.includes('milestoneId=m2'),
          ),
        ).toBe(true);
      });
    });

    it('does not scope by milestone when "All milestones" is selected', async () => {
      render(<AnalyticsPanel activeProjectId="p1" />);
      await waitFor(() => expect(authedFetch).toHaveBeenCalled());
      const calls = vi.mocked(authedFetch).mock.calls.map((c) => c[0]);
      expect(
        calls.every(
          (url) => typeof url === 'string' && !url.includes('milestoneId='),
        ),
      ).toBe(true);
    });

    it('shows a custom date range picker when the Custom preset is selected', async () => {
      render(<AnalyticsPanel activeProjectId="p1" />);
      await waitFor(() => expect(authedFetch).toHaveBeenCalled());
      vi.mocked(authedFetch).mockClear();

      fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

      const fromInput = await screen.findByLabelText('From date');
      const toInput = await screen.findByLabelText('To date');
      expect(fromInput).toBeTruthy();
      expect(toInput).toBeTruthy();

      fireEvent.change(fromInput, { target: { value: '2026-01-01' } });
      fireEvent.change(toInput, { target: { value: '2026-01-15' } });

      await waitFor(() => {
        const calls = vi.mocked(authedFetch).mock.calls.map((c) => c[0]);
        expect(
          calls.some(
            (url) =>
              typeof url === 'string' &&
              url.includes('/api/analytics/tokens?') &&
              url.includes(
                `from=${new Date('2026-01-01T00:00:00.000Z').getTime()}`,
              ) &&
              url.includes(
                `to=${new Date('2026-01-15T23:59:59.999Z').getTime()}`,
              ),
          ),
        ).toBe(true);
      });
    });
  });

  describe('task name/type and drill-in interactions', () => {
    beforeEach(() => {
      vi.mocked(authedFetch).mockImplementation((url) => {
        const s = String(url);
        if (s.includes('/timeseries')) {
          return Promise.resolve(jsonResponse(emptyTimeseriesResponse));
        }
        if (s.includes('/sessions')) {
          return Promise.resolve(jsonResponse(sessionsResponse()));
        }
        return Promise.resolve(jsonResponse(tokensResponse()));
      });
    });

    it('renders task name and type badge instead of a raw id, and clicking it opens the task', async () => {
      const onSelectTask = vi.fn((e: Event) => {
        onSelectTask.mock.calls.at(-1);
        void e;
      });
      window.addEventListener('selectTask', onSelectTask);

      render(<AnalyticsPanel activeProjectId="proj-a" />);

      await screen.findByText('Alpha task');
      expect(screen.getByText('💻 Code')).toBeTruthy();
      expect(screen.queryByText('board-alpha')).toBeNull();

      fireEvent.click(screen.getByText('Alpha task'));

      expect(onSelectTask).toHaveBeenCalledTimes(1);
      const event = onSelectTask.mock.calls[0][0] as CustomEvent<{
        taskId: string;
      }>;
      expect(event.detail.taskId).toBe('notion:board-alpha');

      window.removeEventListener('selectTask', onSelectTask);
    });

    it('does not clip a task name that fits the column width', async () => {
      render(<AnalyticsPanel activeProjectId="proj-a" />);

      const cell = await screen.findByText(LONG_NAME);
      expect(cell.textContent).toBe(LONG_NAME);
    });

    it('dispatches a session-open event with the correct session id on row click', async () => {
      const onSelectSession = vi.fn();
      window.addEventListener('selectSession', onSelectSession);

      render(<AnalyticsPanel activeProjectId="proj-a" />);

      await screen.findByText('Alpha task');
      fireEvent.click(screen.getByText('Alpha task').closest('tr')!);

      await screen.findByText(/session-xyz/);
      fireEvent.click(screen.getByText(/session-xyz/).closest('tr')!);

      expect(onSelectSession).toHaveBeenCalledTimes(1);
      const event = onSelectSession.mock.calls[0][0] as CustomEvent<{
        sessionId: string;
      }>;
      expect(event.detail.sessionId).toBe('session-xyz-123');

      window.removeEventListener('selectSession', onSelectSession);
    });

    it('sorts rows ascending then descending when a column header is clicked', async () => {
      render(<AnalyticsPanel activeProjectId="proj-a" />);

      await screen.findByText('Alpha task');

      const taskHeaderBtn = screen.getByRole('button', { name: /^Task/ });

      // Ascending: LONG_NAME ('aaa…') sorts before 'Alpha task'/'Beta task'.
      fireEvent.click(taskHeaderBtn);
      let rows = screen.getAllByRole('row').slice(1); // drop header row
      let names = rows.map((r) => r.textContent);
      expect(names[0]).toContain(LONG_NAME);

      // Second click reverses to descending: 'Beta task' now leads.
      fireEvent.click(taskHeaderBtn);
      rows = screen.getAllByRole('row').slice(1);
      names = rows.map((r) => r.textContent);
      expect(names[0]).toContain('Beta task');
    });

    it('filters rows by search query, case-insensitively', async () => {
      render(<AnalyticsPanel activeProjectId="proj-a" />);

      await screen.findByText('Alpha task');
      expect(screen.getByText('Beta task')).toBeTruthy();

      const search = screen.getByPlaceholderText('Search tasks…');
      fireEvent.change(search, { target: { value: 'alpha' } });

      await waitFor(() => {
        expect(screen.queryByText('Beta task')).toBeNull();
      });
      expect(screen.getByText('Alpha task')).toBeTruthy();
    });
  });
});
