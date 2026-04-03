import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useSessionStore } from '../useSessionStore';
import type { ServerMessage } from '@claude-dashboard/backend/src/ws/types';

const SESSION_ID = 'test-session-1';

const msg = {
  session_started: (): ServerMessage => ({
    type: 'session_started',
    sessionId: SESSION_ID,
    taskName: 'Test Task',
    notionTaskUrl: 'https://notion.so/task',
  }),
  session_event: (): ServerMessage => ({
    type: 'session_event',
    sessionId: SESSION_ID,
    eventType: 'text',
    content: 'hello',
  }),
  session_status: (): ServerMessage => ({
    type: 'session_status',
    sessionId: SESSION_ID,
    status: 'running',
  }),
  permission_request: (): ServerMessage => ({
    type: 'permission_request',
    sessionId: SESSION_ID,
    toolName: 'Bash',
    proposedAction: 'rm -rf /tmp/test',
  }),
  session_ended: (): ServerMessage => ({
    type: 'session_ended',
    sessionId: SESSION_ID,
    status: 'done',
    prUrl: 'https://github.com/pr/1',
  }),
  tasks_ready: (): ServerMessage => ({
    type: 'tasks_ready',
    tasks: [{
      task: { id: 't1', title: 'Task 1', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: 'https://notion.so/t1' },
      blocked: false,
      blockers: [],
      nonCode: false, wave: 1,
    }],
  }),
};

describe('useSessionStore', () => {
  it('handles session_started', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    const session = result.current.sessions[0];
    expect(session).toBeDefined();
    expect(session.sessionId).toBe(SESSION_ID);
    expect(session.taskName).toBe('Test Task');
    expect(session.status).toBe('starting');
    expect(session.events).toHaveLength(0);
  });

  it('handles session_event — appends to events', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    act(() => result.current.dispatch(msg.session_event()));
    const session = result.current.sessions[0];
    expect(session.events).toHaveLength(1);
    expect(session.events[0].content).toBe('hello');
    expect(session.events[0].eventType).toBe('text');
  });

  it('handles session_status — updates status field', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    act(() => result.current.dispatch(msg.session_status()));
    expect(result.current.sessions[0].status).toBe('running');
  });

  it('handles permission_request — sets needs_permission status and pendingPermission', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    act(() => result.current.dispatch(msg.permission_request()));
    const session = result.current.sessions[0];
    expect(session.status).toBe('needs_permission');
    expect(session.pendingPermission?.toolName).toBe('Bash');
    expect(session.pendingPermission?.proposedAction).toBe('rm -rf /tmp/test');
  });

  it('handles session_ended — sets final status and prUrl, clears pendingPermission', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    act(() => result.current.dispatch(msg.permission_request()));
    act(() => result.current.dispatch(msg.session_ended()));
    const session = result.current.sessions[0];
    expect(session.status).toBe('done');
    expect(session.prUrl).toBe('https://github.com/pr/1');
    expect(session.pendingPermission).toBeUndefined();
  });

  it('handles tasks_ready — updates tasks list and sets tasksReady flag', () => {
    const { result } = renderHook(() => useSessionStore());
    expect(result.current.tasks).toHaveLength(0);
    expect(result.current.tasksReady).toBe(false);
    act(() => result.current.dispatch(msg.tasks_ready()));
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].task.title).toBe('Task 1');
    expect(result.current.tasksReady).toBe(true);
  });

  it('tasksReady remains true on subsequent tasks_ready (empty board)', () => {
    const { result } = renderHook(() => useSessionStore());
    const emptyTasksReady: ServerMessage = { type: 'tasks_ready', tasks: [] };
    act(() => result.current.dispatch(emptyTasksReady));
    expect(result.current.tasksReady).toBe(true);
    expect(result.current.tasks).toHaveLength(0);
  });

  it('each session_started dispatch returns a new Map (immutable update)', () => {
    const { result } = renderHook(() => useSessionStore());
    const before = result.current.sessions;
    act(() => result.current.dispatch(msg.session_started()));
    const after = result.current.sessions;
    // sessions array reference changes because a new Map was created
    expect(after).not.toBe(before);
  });

  it('readyCount counts only tasks with status Ready and blocked false', () => {
    const { result } = renderHook(() => useSessionStore());
    const tasksMsg: ServerMessage = {
      type: 'tasks_ready',
      tasks: [
        { task: { id: 't1', title: 'Task 1', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: false, blockers: [], nonCode: false, wave: 1 },
        { task: { id: 't2', title: 'Task 2', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: true, blockers: [], nonCode: false, wave: 1 },
        { task: { id: 't3', title: 'Task 3', status: '🔄 In Progress', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: false, blockers: [], nonCode: false, wave: 1 },
      ],
    };
    act(() => result.current.dispatch(tasksMsg));
    expect(result.current.readyCount).toBe(1);
  });

  it('blockedCount counts only tasks with blocked true', () => {
    const { result } = renderHook(() => useSessionStore());
    const tasksMsg: ServerMessage = {
      type: 'tasks_ready',
      tasks: [
        { task: { id: 't1', title: 'Task 1', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: false, blockers: [], nonCode: false, wave: 1 },
        { task: { id: 't2', title: 'Task 2', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: true, blockers: [], nonCode: false, wave: 1 },
        { task: { id: 't3', title: 'Task 3', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: true, blockers: [], nonCode: false, wave: 1 },
      ],
    };
    act(() => result.current.dispatch(tasksMsg));
    expect(result.current.blockedCount).toBe(2);
  });

  it('resetTasks sets tasksReady to false', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.tasks_ready()));
    expect(result.current.tasksReady).toBe(true);
    act(() => result.current.resetTasks());
    expect(result.current.tasksReady).toBe(false);
  });

  it('resetTasks clears tasks array', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.tasks_ready()));
    expect(result.current.tasks).toHaveLength(1);
    act(() => result.current.resetTasks());
    expect(result.current.tasks).toHaveLength(0);
  });

  it('after resetTasks, a subsequent tasks_ready message sets tasksReady back to true', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.tasks_ready()));
    act(() => result.current.resetTasks());
    expect(result.current.tasksReady).toBe(false);
    act(() => result.current.dispatch(msg.tasks_ready()));
    expect(result.current.tasksReady).toBe(true);
    expect(result.current.tasks).toHaveLength(1);
  });

  it('readyCount and blockedCount are both 0 when tasks is empty', () => {
    const { result } = renderHook(() => useSessionStore());
    expect(result.current.readyCount).toBe(0);
    expect(result.current.blockedCount).toBe(0);
  });

  it('each session_event dispatch produces a new array reference', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    const before = result.current.sessions;
    act(() => result.current.dispatch(msg.session_event()));
    expect(result.current.sessions).not.toBe(before);
    expect(result.current.sessions[0].events).not.toBe(before[0]?.events);
  });

  it('isRateLimited is true when a rate_limit_event with status "rate_limited" arrives', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    const rateLimitEvent: ServerMessage = {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rate_limited' } }),
    };
    act(() => result.current.dispatch(rateLimitEvent));
    expect(result.current.sessions[0].isRateLimited).toBe(true);
  });

  it('isRateLimited stays true across non-rate-limit events (sticky)', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    const rateLimitEvent: ServerMessage = {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rate_limited' } }),
    };
    act(() => result.current.dispatch(rateLimitEvent));
    expect(result.current.sessions[0].isRateLimited).toBe(true);
    // Normal event arrives — flag should NOT reset
    act(() => result.current.dispatch(msg.session_event()));
    expect(result.current.sessions[0].isRateLimited).toBe(true);
  });

  it('isRateLimited clears only when a rate_limit_event with status "resumed" arrives', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    const rateLimitEvent: ServerMessage = {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rate_limited' } }),
    };
    act(() => result.current.dispatch(rateLimitEvent));
    expect(result.current.sessions[0].isRateLimited).toBe(true);
    const resumedEvent: ServerMessage = {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'resumed' } }),
    };
    act(() => result.current.dispatch(resumedEvent));
    expect(result.current.sessions[0].isRateLimited).toBe(false);
  });

  it('isRateLimited is falsy for normal events without rate_limit_event', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    act(() => result.current.dispatch(msg.session_event()));
    expect(result.current.sessions[0].isRateLimited).toBeFalsy();
  });

  describe('review_incomplete handling', () => {
    it('adds entry to incompleteReviews when review_incomplete message arrives', () => {
      const { result } = renderHook(() => useSessionStore());
      const reviewIncompleteMsg: ServerMessage = {
        type: 'review_incomplete',
        prNumber: 42,
        repo: 'owner/repo',
        message: 'Reviewer could not assess the PR.',
      };
      act(() => result.current.dispatch(reviewIncompleteMsg));
      expect(result.current.incompleteReviews).toHaveLength(1);
      expect(result.current.incompleteReviews[0]).toMatchObject({ prNumber: 42, repo: 'owner/repo' });
    });

    it('accumulates multiple review_incomplete messages', () => {
      const { result } = renderHook(() => useSessionStore());
      const makeMsg = (prNumber: number): ServerMessage => ({
        type: 'review_incomplete',
        prNumber,
        repo: 'owner/repo',
        message: 'Could not assess.',
      });
      act(() => result.current.dispatch(makeMsg(1)));
      act(() => result.current.dispatch(makeMsg(2)));
      expect(result.current.incompleteReviews).toHaveLength(2);
    });

    it('dismissIncompleteReviews clears the incompleteReviews array', () => {
      const { result } = renderHook(() => useSessionStore());
      const reviewIncompleteMsg: ServerMessage = {
        type: 'review_incomplete',
        prNumber: 42,
        repo: 'owner/repo',
        message: 'Could not assess.',
      };
      act(() => result.current.dispatch(reviewIncompleteMsg));
      expect(result.current.incompleteReviews).toHaveLength(1);
      act(() => result.current.dismissIncompleteReviews());
      expect(result.current.incompleteReviews).toHaveLength(0);
    });
  });

  describe('task_status_changed handling', () => {
    it('patches matching task status in the tasks array', () => {
      const { result } = renderHook(() => useSessionStore());
      const tasksMsg: ServerMessage = {
        type: 'tasks_ready',
        tasks: [
          { task: { id: 'abc123', title: 'Task A', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: false, blockers: [], nonCode: false, wave: 1 },
        ],
      };
      act(() => result.current.dispatch(tasksMsg));
      const changed: ServerMessage = { type: 'task_status_changed', notionTaskId: 'abc123', newStatus: '🔄 In Progress' };
      act(() => result.current.dispatch(changed));
      expect(result.current.tasks[0].task.status).toBe('🔄 In Progress');
    });

    it('is a no-op for unknown task ID', () => {
      const { result } = renderHook(() => useSessionStore());
      const tasksMsg: ServerMessage = {
        type: 'tasks_ready',
        tasks: [
          { task: { id: 'abc123', title: 'Task A', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: false, blockers: [], nonCode: false, wave: 1 },
        ],
      };
      act(() => result.current.dispatch(tasksMsg));
      const changed: ServerMessage = { type: 'task_status_changed', notionTaskId: 'unknown-id', newStatus: '🔄 In Progress' };
      act(() => result.current.dispatch(changed));
      expect(result.current.tasks[0].task.status).toBe('🗂️ Ready');
    });

    it('only patches the matching task, leaving others unchanged', () => {
      const { result } = renderHook(() => useSessionStore());
      const tasksMsg: ServerMessage = {
        type: 'tasks_ready',
        tasks: [
          { task: { id: 'task-1', title: 'Task 1', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: false, blockers: [], nonCode: false, wave: 1 },
          { task: { id: 'task-2', title: 'Task 2', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: false, blockers: [], nonCode: false, wave: 1 },
        ],
      };
      act(() => result.current.dispatch(tasksMsg));
      const changed: ServerMessage = { type: 'task_status_changed', notionTaskId: 'task-1', newStatus: '👀 In Review' };
      act(() => result.current.dispatch(changed));
      expect(result.current.tasks[0].task.status).toBe('👀 In Review');
      expect(result.current.tasks[1].task.status).toBe('🗂️ Ready');
    });
  });

  describe('dismissDenial / dismissAllDenials', () => {
    const SESSION_A = 'session-a';
    const SESSION_B = 'session-b';

    it('dismissing a denial for session A persists when switching to session B and back to A', () => {
      const { result } = renderHook(() => useSessionStore());

      act(() => result.current.dismissDenial(SESSION_A, 'tool-use-1'));

      // Session A has the dismissed ID
      expect(result.current.dismissedDenialIds.get(SESSION_A)?.has('tool-use-1')).toBe(true);

      // "Switch" to session B — no dismissals there yet
      expect(result.current.dismissedDenialIds.get(SESSION_B)).toBeUndefined();

      // "Switch back" to session A — dismissal still present
      expect(result.current.dismissedDenialIds.get(SESSION_A)?.has('tool-use-1')).toBe(true);
    });

    it('dismissing denials for session A does not affect session B', () => {
      const { result } = renderHook(() => useSessionStore());

      act(() => result.current.dismissDenial(SESSION_A, 'tool-use-1'));
      act(() => result.current.dismissDenial(SESSION_A, 'tool-use-2'));

      expect(result.current.dismissedDenialIds.get(SESSION_A)?.size).toBe(2);
      expect(result.current.dismissedDenialIds.get(SESSION_B)).toBeUndefined();
    });

    it('dismissAllDenials sets all provided IDs as dismissed for the session', () => {
      const { result } = renderHook(() => useSessionStore());

      act(() => result.current.dismissAllDenials(SESSION_A, ['tool-use-1', 'tool-use-2', 'tool-use-3']));

      const dismissed = result.current.dismissedDenialIds.get(SESSION_A);
      expect(dismissed?.has('tool-use-1')).toBe(true);
      expect(dismissed?.has('tool-use-2')).toBe(true);
      expect(dismissed?.has('tool-use-3')).toBe(true);
    });

    it('dismissAllDenials for session A does not affect session B', () => {
      const { result } = renderHook(() => useSessionStore());

      act(() => result.current.dismissDenial(SESSION_B, 'tool-use-b'));
      act(() => result.current.dismissAllDenials(SESSION_A, ['tool-use-1', 'tool-use-2']));

      expect(result.current.dismissedDenialIds.get(SESSION_B)?.has('tool-use-b')).toBe(true);
      expect(result.current.dismissedDenialIds.get(SESSION_A)?.has('tool-use-b')).toBe(false);
    });
  });
});
