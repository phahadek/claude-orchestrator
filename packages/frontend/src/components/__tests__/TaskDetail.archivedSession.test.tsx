import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TaskDetail } from '../TaskDetail';
import { sessionsApi } from '../../api/projects';
import type { SessionWithEvents } from '../../api/projects';
import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type { SessionState } from '../../hooks/useSessionStore';
import type { Session } from '@claude-orchestrator/backend/src/db/types';

function makeTask(overrides?: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Implement something',
    notionStatus: '🔄 In Progress',
    displayStatus: 'in_progress',
    pauseReason: null,
    priority: '🔴 High',
    notionUrl: 'https://notion.so/task-1',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    planningSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
    ...overrides,
  };
}

function makePlanningSession(
  overrides?: Partial<NonNullable<TaskView['planningSession']>>,
): NonNullable<TaskView['planningSession']> {
  return {
    sessionId: 'plan-sess-1',
    status: 'idle',
    sessionType: 'groom',
    startedAt: Date.now() - 60000,
    endedAt: Date.now() - 1000,
    inputTokens: 500,
    outputTokens: 200,
    ...overrides,
  };
}

function makeReview(
  overrides?: Partial<NonNullable<TaskView['review']>>,
): NonNullable<TaskView['review']> {
  return {
    sessionId: 'review-sess-1',
    status: 'done',
    verdict: 'approved',
    summary: 'All checks pass.',
    iterationCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function makeSessionState(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: 'sess-1',
    taskName: 'Test Task',
    notionTaskUrl: 'https://notion.so/task',
    status: 'idle',
    events: [],
    ...overrides,
  };
}

function makeDbSession(overrides?: Partial<Session>): Session {
  return {
    session_id: 'plan-sess-1',
    task_id: 'task-1',
    task_url: 'https://notion.so/task-1',
    project_context_url: null,
    project_id: 'proj-1',
    status: 'idle',
    started_at: Date.now() - 60000,
    ended_at: Date.now() - 1000,
    pr_url: null,
    worktree_path: null,
    archived: 1,
    favorited: 0,
    session_type: 'groom',
    note: null,
    tags: null,
    total_input_tokens: 500,
    total_output_tokens: 200,
    compaction_count: 0,
    context_occupancy_tokens: 0,
    model: null,
    task_name: 'Implement something',
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    granted_capabilities: '[]',
    ...overrides,
  } as Session;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TaskDetail — archived session resolution', () => {
  it('renders the session panel (not the placeholder) for a planning session already marked archived in the store', () => {
    const planningSession = makePlanningSession({ sessionId: 'plan-sess-1' });
    const sessions: SessionState[] = [
      makeSessionState({ sessionId: 'plan-sess-1', archived: true }),
    ];
    render(
      <TaskDetail
        task={makeTask({ planningSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
      />,
    );
    expect(screen.getByTestId('planning-session-body')).toBeTruthy();
    expect(screen.queryByText(/Transcript not available/)).toBeNull();
  });

  it('fetches an archived planning session by id on a resolution miss and renders it once loaded', async () => {
    const response: SessionWithEvents = {
      session: makeDbSession(),
      events: [],
    };
    const getByIdSpy = vi
      .spyOn(sessionsApi, 'getById')
      .mockResolvedValue(response);

    const planningSession = makePlanningSession({ sessionId: 'plan-sess-1' });
    render(
      <TaskDetail
        task={makeTask({ planningSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={[]}
      />,
    );

    // Not yet resolved — loading placeholder, distinct from the "not found" wording.
    expect(screen.getByText(/Transcript not available.*loading/i)).toBeTruthy();

    await waitFor(() => {
      expect(getByIdSpy).toHaveBeenCalledWith('plan-sess-1');
    });
    await waitFor(() => {
      expect(screen.getByTestId('planning-session-body')).toBeTruthy();
    });
    expect(screen.queryByText(/Transcript not available/)).toBeNull();
  });

  it('shows a genuinely-not-found placeholder, distinct from the loading one, when the fetch fails', async () => {
    vi.spyOn(sessionsApi, 'getById').mockRejectedValue(
      new Error('404 Not Found'),
    );

    const planningSession = makePlanningSession({ sessionId: 'missing-sess' });
    render(
      <TaskDetail
        task={makeTask({ planningSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={[]}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Transcript not available.*not found/i),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/loading session/i)).toBeNull();
  });

  it('resolves an archived review session the same way on the review section', async () => {
    const response: SessionWithEvents = {
      session: makeDbSession({
        session_id: 'review-sess-1',
        session_type: 'review',
      }),
      events: [],
    };
    vi.spyOn(sessionsApi, 'getById').mockResolvedValue(response);

    const review = makeReview({ sessionId: 'review-sess-1' });
    render(
      <TaskDetail
        task={makeTask({ review })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={[]}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Review transcript not available/)).toBeNull();
    });
  });
});
