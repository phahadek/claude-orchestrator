// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { SessionState } from '../hooks/useSessionStore';

const PROJECT_ID = 'proj-1';

function autoLaunchRunningCount(
  sessions: SessionState[],
  activeProjectId: string,
): number {
  return sessions.filter(
    (s) =>
      !s.archived &&
      s.project_id === activeProjectId &&
      (s.sessionType ?? 'standard') === 'standard' &&
      (s.status === 'running' || s.status === 'needs_permission'),
  ).length;
}

function makeSession(overrides: Partial<SessionState>): SessionState {
  return {
    sessionId: 'sid-1',
    taskName: 'Test task',
    notionTaskUrl: '',
    status: 'starting',
    events: [],
    project_id: PROJECT_ID,
    archived: false,
    ...overrides,
  };
}

describe('autoLaunchRunningCount', () => {
  it('counts a running session with no sessionType field as standard', () => {
    const session = makeSession({ status: 'running' });
    // sessionType is absent — backend omits it for 'standard' sessions
    expect('sessionType' in session).toBe(false);
    expect(autoLaunchRunningCount([session], PROJECT_ID)).toBe(1);
  });

  it('counts a needs_permission session with no sessionType as standard', () => {
    const session = makeSession({ status: 'needs_permission' });
    expect(autoLaunchRunningCount([session], PROJECT_ID)).toBe(1);
  });

  it('does not count a running review session', () => {
    const session = makeSession({ status: 'running', sessionType: 'review' });
    expect(autoLaunchRunningCount([session], PROJECT_ID)).toBe(0);
  });

  it('counts a running session with explicit sessionType standard', () => {
    const session = makeSession({ status: 'running', sessionType: 'standard' });
    expect(autoLaunchRunningCount([session], PROJECT_ID)).toBe(1);
  });

  it('does not count archived sessions', () => {
    const session = makeSession({ status: 'running', archived: true });
    expect(autoLaunchRunningCount([session], PROJECT_ID)).toBe(0);
  });

  it('does not count sessions from a different project', () => {
    const session = makeSession({
      status: 'running',
      project_id: 'other-proj',
    });
    expect(autoLaunchRunningCount([session], PROJECT_ID)).toBe(0);
  });

  it('does not count done or error sessions', () => {
    const done = makeSession({ status: 'done' });
    const error = makeSession({ status: 'error' });
    expect(autoLaunchRunningCount([done, error], PROJECT_ID)).toBe(0);
  });
});
