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
      nonCode: false,
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
        { task: { id: 't1', title: 'Task 1', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: false, blockers: [], nonCode: false },
        { task: { id: 't2', title: 'Task 2', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: true, blockers: [], nonCode: false },
        { task: { id: 't3', title: 'Task 3', status: '🔄 In Progress', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: false, blockers: [], nonCode: false },
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
        { task: { id: 't1', title: 'Task 1', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: false, blockers: [], nonCode: false },
        { task: { id: 't2', title: 'Task 2', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: true, blockers: [], nonCode: false },
        { task: { id: 't3', title: 'Task 3', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: '' }, blocked: true, blockers: [], nonCode: false },
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

  it('isRateLimited is true when last event has error === "rate_limit" in payload', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    const rateLimitEvent: ServerMessage = {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'text',
      content: JSON.stringify({ type: 'assistant', error: 'rate_limit', isApiErrorMessage: true }),
    };
    act(() => result.current.dispatch(rateLimitEvent));
    expect(result.current.sessions[0].isRateLimited).toBe(true);
  });

  it('isRateLimited is false after a non-rate-limit event arrives (user resumed)', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    const rateLimitEvent: ServerMessage = {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'text',
      content: JSON.stringify({ type: 'assistant', error: 'rate_limit', isApiErrorMessage: true }),
    };
    act(() => result.current.dispatch(rateLimitEvent));
    expect(result.current.sessions[0].isRateLimited).toBe(true);
    // Normal event arrives after resuming
    act(() => result.current.dispatch(msg.session_event()));
    expect(result.current.sessions[0].isRateLimited).toBe(false);
  });

  it('isRateLimited is false for normal events without rate_limit error', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.dispatch(msg.session_started()));
    act(() => result.current.dispatch(msg.session_event()));
    expect(result.current.sessions[0].isRateLimited).toBe(false);
  });
});
