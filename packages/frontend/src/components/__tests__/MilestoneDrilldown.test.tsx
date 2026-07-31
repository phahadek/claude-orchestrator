import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MilestoneDrilldown } from '../MilestoneDrilldown';
import { stagedIntentsApi } from '../../api/stagedIntents';
import { sessionsApi } from '../../api/projects';
import type { StagedIntent } from '../../api/stagedIntents';
import type { TaskView } from '../../types/taskView';

vi.mock('../../hooks/stagedIntentBus', () => ({
  subscribeStagedIntentChange: () => () => {},
}));

function makeTask(overrides: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Do the thing',
    notionStatus: '🔄 In Progress',
    displayStatus: 'in_progress',
    pauseReason: null,
    priority: '🟡 Medium',
    notionUrl: '',
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

const noop = () => {};

describe('MilestoneDrilldown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the resolved task's name and Type in the header", async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);
    const task = makeTask({
      taskId: 'task-1',
      taskName: 'Do the thing',
      taskType: '💻 Code',
    });

    render(
      <MilestoneDrilldown
        selection={{ type: 'task', task }}
        tasks={[task]}
        projectId="proj-1"
        sessions={[]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('milestone-task-reader').textContent).toContain(
        'Do the thing',
      ),
    );
    expect(screen.getByTestId('milestone-task-reader').textContent).toContain(
      '💻 Code',
    );
  });

  it('renders a defined, non-"Task" fallback when no task resolves', () => {
    const intent: StagedIntent = {
      id: 'intent-create',
      kind: 'task.create',
      payload: { title: 'New task' },
      projectId: 'proj-1',
      createdAt: 1,
      sessionId: null,
      milestone: 'M1',
      state: 'staged',
    };

    render(
      <MilestoneDrilldown
        selection={{ type: 'intent', intent }}
        tasks={[]}
        projectId="proj-1"
        sessions={[]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );

    const heading = screen.getByTestId('milestone-task-reader');
    expect(heading.textContent).not.toContain('Task');
    expect(heading.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('shows an empty state when nothing is selected', () => {
    render(
      <MilestoneDrilldown
        selection={null}
        tasks={[]}
        projectId="proj-1"
        sessions={[]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );
    expect(screen.getByTestId('milestone-drilldown-empty')).toBeTruthy();
  });

  it('drives the task reader + SessionPanel embed from a selected launched task', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([
      {
        id: 'intent-1',
        kind: 'task.setStatus',
        payload: { taskId: 'task-1', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'sess-1',
        milestone: 'M1',
        state: 'staged',
      },
    ]);
    const task = makeTask({
      taskId: 'task-1',
      codeSession: {
        sessionId: 'sess-1',
        status: 'running',
        startedAt: 1,
        endedAt: null,
        lastMessage: '',
        inputTokens: 0,
        outputTokens: 0,
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ markdown: '# Spec body' }),
      }),
    );

    render(
      <MilestoneDrilldown
        selection={{ type: 'task', task }}
        tasks={[task]}
        projectId="proj-1"
        sessions={[
          {
            sessionId: 'sess-1',
            taskName: 'Do the thing',
            notionTaskUrl: '',
            status: 'running',
            events: [],
          },
        ]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );

    await waitFor(() => expect(screen.getByText('Spec body')).toBeTruthy());
    expect(screen.getByText('No events yet.')).toBeTruthy();
    // The embedded SessionPanel must not duplicate the centre column's
    // decision inbox — the milestone drill-down opts out of DecisionPanel.
    expect(screen.queryByTestId('decision-panel')).toBeNull();
  });

  it('handles an unresolvable create-intent gracefully', async () => {
    const intent: StagedIntent = {
      id: 'intent-create',
      kind: 'task.create',
      payload: { title: 'New task' },
      projectId: 'proj-1',
      createdAt: 1,
      sessionId: null,
      milestone: 'M1',
      state: 'staged',
    };

    render(
      <MilestoneDrilldown
        selection={{ type: 'intent', intent }}
        tasks={[]}
        projectId="proj-1"
        sessions={[]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );

    expect(
      screen.getByTestId('milestone-drilldown-unresolved').textContent,
    ).toContain("doesn't reference an existing task yet");
    expect(screen.getByText('No associated session.')).toBeTruthy();
  });

  it('resolves a decision.pickOne intent (no payload.taskId) via its originating session', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);
    const originalPayload = {
      question: 'Which approach?',
      options: ['a', 'b'],
    };
    const intent: StagedIntent = {
      id: 'intent-decision',
      kind: 'decision.pickOne',
      payload: originalPayload,
      projectId: 'proj-1',
      createdAt: 1,
      sessionId: 'sess-2',
      milestone: 'M1',
      state: 'staged',
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo) => {
        const url = String(input);
        if (url.includes('/api/sessions/sess-2/events')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              session: {
                session_id: 'sess-2',
                task_id: 'task-fallback',
                task_name: 'Do the thing',
                task_url: '',
                status: 'done',
                started_at: 1,
                ended_at: null,
                archived: 0,
                favorited: 0,
                project_id: 'proj-1',
                session_type: 'standard',
              },
              events: [],
            }),
          });
        }
        if (url.includes('/api/tasks/task-fallback/page')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ markdown: '# Fallback spec body' }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        });
      }),
    );

    render(
      <MilestoneDrilldown
        selection={{ type: 'intent', intent }}
        tasks={[]}
        projectId="proj-1"
        sessions={[]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText('Fallback spec body')).toBeTruthy(),
    );
    expect(intent.payload).toBe(originalPayload);
    expect((intent.payload as { taskId?: unknown }).taskId).toBeUndefined();
  });

  it('renders the empty state for an intent with no payload.taskId and no resolvable session', async () => {
    const intent: StagedIntent = {
      id: 'intent-decision-orphan',
      kind: 'decision.pickOne',
      payload: { question: 'Which approach?' },
      projectId: 'proj-1',
      createdAt: 1,
      sessionId: null,
      milestone: 'M1',
      state: 'staged',
    };

    render(
      <MilestoneDrilldown
        selection={{ type: 'intent', intent }}
        tasks={[]}
        projectId="proj-1"
        sessions={[]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );

    expect(
      screen.getByTestId('milestone-drilldown-unresolved').textContent,
    ).toContain("doesn't reference an existing task yet");
    expect(screen.getByText('No associated session.')).toBeTruthy();
  });

  it('shows a loading indication, never a blank pane, for a session absent from the live store', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);
    // Fallback fetch never resolves within this test — proves the very
    // first render (before the resolution effect runs) is non-blank.
    vi.spyOn(sessionsApi, 'getById').mockReturnValue(new Promise(() => {}));
    const task = makeTask({
      taskId: 'task-1',
      codeSession: {
        sessionId: 'sess-missing',
        status: 'running',
        startedAt: 1,
        endedAt: null,
        lastMessage: '',
        inputTokens: 0,
        outputTokens: 0,
      },
    });

    render(
      <MilestoneDrilldown
        selection={{ type: 'task', task }}
        tasks={[task]}
        projectId="proj-1"
        sessions={[]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );

    const embed = screen.getByTestId('milestone-session-embed');
    expect(embed.textContent).toContain('Loading session…');
    expect(embed.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("renders an archived session's panel when it is still present in the live store", async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);
    const task = makeTask({
      taskId: 'task-1',
      codeSession: {
        sessionId: 'sess-archived',
        status: 'done',
        startedAt: 1,
        endedAt: 2,
        lastMessage: '',
        inputTokens: 0,
        outputTokens: 0,
      },
    });

    render(
      <MilestoneDrilldown
        selection={{ type: 'task', task }}
        tasks={[task]}
        projectId="proj-1"
        sessions={[
          {
            sessionId: 'sess-archived',
            taskName: 'Do the thing',
            notionTaskUrl: '',
            status: 'done',
            events: [],
            archived: true,
          },
        ]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText('No events yet.')).toBeTruthy(),
    );
    const embed = screen.getByTestId('milestone-session-embed');
    expect(embed.textContent).not.toContain('Transcript not available');
  });

  describe('long unbreakable tokens in the task body', () => {
    it('renders a 40-character commit SHA in full rather than truncating or erroring', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);
      const sha = 'a07c76a390ece5c531b020688f5351a10d0baf4b'.slice(0, 40);
      const task = makeTask({ taskId: 'task-long-token' });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            markdown: `## Context\n\nAnchors read at checkout HEAD ${sha}.\n\n- path: packages/backend/src/${sha}/index.ts\n\n| SHA | Note |\n| --- | --- |\n| ${sha} | table cell |\n`,
          }),
        }),
      );

      render(
        <MilestoneDrilldown
          selection={{ type: 'task', task }}
          tasks={[task]}
          projectId="proj-1"
          sessions={[]}
          send={noop}
          setSessionArchived={noop}
          setSessionFavorited={noop}
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId('milestone-task-reader').textContent).toContain(
          sha,
        ),
      );
      // The SHA appears in the paragraph, the list item, and the table cell —
      // all three text-element kinds react-markdown emits for prose bodies.
      const occurrences = (
        screen.getByTestId('milestone-task-reader').textContent ?? ''
      ).split(sha).length - 1;
      expect(occurrences).toBe(3);
    });
  });
});
