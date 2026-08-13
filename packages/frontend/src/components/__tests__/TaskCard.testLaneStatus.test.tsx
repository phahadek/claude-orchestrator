import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskCard } from '../TaskCard';
import { publishTestRequestRunStatus } from '../../hooks/testRequestRunStatusBus';
import type { TaskView } from '../../types/taskView';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

function makeTask(overrides?: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Implement Feature',
    notionStatus: '🗂️ Ready',
    displayStatus: 'in_progress',
    pauseReason: null,
    priority: '',
    notionUrl: 'https://notion.so/task-1',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: {
      sessionId: 'sess-1',
      status: 'running',
      startedAt: Date.now() - 60_000,
      endedAt: null,
      lastMessage: '',
      inputTokens: 0,
      outputTokens: 0,
    },
    planningSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
    ...overrides,
  } as TaskView;
}

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Test Project',
    path: '/repos/test',
    contextUrl: 'https://notion.so/context',
    boardId: 'board-1',
    taskSource: 'notion',
    ...overrides,
  } as ProjectConfig;
}

const noop = vi.fn();
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ run: null }), { status: 200 }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('TaskCard — governed test-lane run status', () => {
  it('renders in-flight from a mocked test_request_run_status WS payload', async () => {
    render(
      <TaskCard
        task={makeTask()}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    await flush();
    act(() => {
      publishTestRequestRunStatus({
        runId: 'run-1',
        projectId: 'proj-1',
        contentHash: 'hash-1',
        status: 'running',
        sessionId: 'sess-1',
        requestedAt: Date.now(),
        startedAt: Date.now(),
      });
    });
    expect(await screen.findByText('🧪 Tests running')).toBeTruthy();
  });

  it('renders passed from a mocked test_request_run_status WS payload', async () => {
    render(
      <TaskCard
        task={makeTask()}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    await flush();
    act(() => {
      publishTestRequestRunStatus({
        runId: 'run-1',
        projectId: 'proj-1',
        contentHash: 'hash-1',
        status: 'passed',
        sessionId: 'sess-1',
        startedAt: Date.now() - 1000,
        finishedAt: Date.now(),
      });
    });
    expect(await screen.findByText('🧪 Tests passed')).toBeTruthy();
  });

  it('renders failed-with-cause from a mocked test_request_run_status WS payload', async () => {
    render(
      <TaskCard
        task={makeTask()}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    await flush();
    act(() => {
      publishTestRequestRunStatus({
        runId: 'run-1',
        projectId: 'proj-1',
        contentHash: 'hash-1',
        status: 'failed-with-cause',
        output: 'AssertionError: expected 1 to equal 2',
        sessionId: 'sess-1',
        startedAt: Date.now() - 1000,
        finishedAt: Date.now(),
      });
    });
    const badge = await screen.findByText('🧪 Tests failed');
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('title')).toBe(
      'AssertionError: expected 1 to equal 2',
    );
  });

  it('renders blocked directly from pauseReason, without a lane run', async () => {
    render(
      <TaskCard
        task={makeTask({ pauseReason: 'test_request_cycle_exceeded' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(await screen.findByText('🧪 Tests blocked')).toBeTruthy();
  });

  it('ignores a WS payload for a different session', async () => {
    render(
      <TaskCard
        task={makeTask()}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    await flush();
    act(() => {
      publishTestRequestRunStatus({
        runId: 'run-2',
        projectId: 'proj-1',
        contentHash: 'hash-2',
        status: 'running',
        sessionId: 'some-other-session',
        startedAt: Date.now(),
      });
    });
    expect(screen.queryByText('🧪 Tests running')).toBeNull();
  });
});
