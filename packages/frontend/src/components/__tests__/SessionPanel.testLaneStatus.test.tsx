import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionPanel } from '../SessionPanel';
import { publishTestRequestRunStatus } from '../../hooks/testRequestRunStatusBus';
import type { SessionState } from '../../hooks/useSessionStore';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ run: null }), { status: 200 }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: 'sess-1',
    taskName: 'Test Task',
    notionTaskUrl: 'https://notion.so/task',
    status: 'running',
    events: [],
    project_id: 'proj-1',
    ...overrides,
  };
}

const defaultProps = {
  send: vi.fn() as (msg: ClientMessage) => void,
  setSessionArchived: vi.fn(),
  setSessionFavorited: vi.fn(),
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('SessionPanel — governed test-lane run detail', () => {
  it('renders no lane detail when there is no run for this session', async () => {
    render(<SessionPanel session={makeSession()} {...defaultProps} />);
    await flush();
    expect(screen.queryByTestId('test-lane-detail')).toBeNull();
  });

  it('renders the failure output when present', async () => {
    render(<SessionPanel session={makeSession()} {...defaultProps} />);
    await flush();
    act(() => {
      publishTestRequestRunStatus({
        runId: 'run-1',
        projectId: 'proj-1',
        contentHash: 'hash-1',
        status: 'failed-with-cause',
        output: 'boom: test 3 failed',
        sessionId: 'sess-1',
        startedAt: Date.now() - 500,
        finishedAt: Date.now(),
      });
    });
    expect(await screen.findByText('🧪 Governed test run failed')).toBeTruthy();
    expect(screen.getByText('boom: test 3 failed')).toBeTruthy();
    expect(screen.queryByTestId('test-lane-note')).toBeNull();
  });

  it('renders the admission-wait/coalescing note only when the queue gap is significant', async () => {
    render(<SessionPanel session={makeSession()} {...defaultProps} />);
    await flush();
    const requestedAt = Date.now() - 10_000;
    act(() => {
      publishTestRequestRunStatus({
        runId: 'run-2',
        projectId: 'proj-1',
        contentHash: 'hash-2',
        status: 'running',
        sessionId: 'sess-1',
        requestedAt,
        startedAt: Date.now(),
      });
    });
    expect(
      await screen.findByText('🧪 Governed test run in progress'),
    ).toBeTruthy();
    expect(screen.getByTestId('test-lane-note')).toBeTruthy();
  });

  it('omits the note when the run started immediately after being requested', async () => {
    render(<SessionPanel session={makeSession()} {...defaultProps} />);
    await flush();
    const requestedAt = Date.now();
    act(() => {
      publishTestRequestRunStatus({
        runId: 'run-3',
        projectId: 'proj-1',
        contentHash: 'hash-3',
        status: 'running',
        sessionId: 'sess-1',
        requestedAt,
        startedAt: requestedAt,
      });
    });
    expect(
      await screen.findByText('🧪 Governed test run in progress'),
    ).toBeTruthy();
    expect(screen.queryByTestId('test-lane-note')).toBeNull();
  });
});
