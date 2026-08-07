import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyticsPanel } from '../AnalyticsPanel';

const mockAuthedFetch = vi.fn();

vi.mock('../../api/projects', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}));

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
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

beforeEach(() => {
  mockAuthedFetch.mockReset();
  mockAuthedFetch.mockImplementation((url: string) => {
    if (url.includes('/sessions')) return jsonResponse(sessionsResponse());
    return jsonResponse(tokensResponse());
  });
});

describe('AnalyticsPanel', () => {
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
