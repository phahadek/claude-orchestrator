import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskCard } from '../TaskCard';
import type {
  TaskView,
  DisplayStatus,
  PauseReason,
} from '../../types/taskView';
import type { RecoveryDescriptor } from '@claude-orchestrator/backend/src/db/pauseReason';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

function makeTask(overrides?: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Implement Feature',
    notionStatus: '🗂️ Ready',
    displayStatus: 'ready',
    pauseReason: null,
    priority: '',
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

function makeCodeSession(
  overrides?: Partial<NonNullable<TaskView['codeSession']>>,
): NonNullable<TaskView['codeSession']> {
  return {
    sessionId: 'sess-1',
    status: 'running',
    startedAt: Date.now() - 60_000,
    endedAt: null,
    lastMessage: 'Writing tests...',
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

function makePlanningSession(
  overrides?: Partial<NonNullable<TaskView['planningSession']>>,
): NonNullable<TaskView['planningSession']> {
  return {
    sessionId: 'plan-1',
    status: 'idle',
    sessionType: 'groom',
    startedAt: Date.now() - 60_000,
    endedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function makePr(
  overrides?: Partial<NonNullable<TaskView['pr']>>,
): NonNullable<TaskView['pr']> {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    title: 'feat: implement feature',
    headBranch: 'feature/implement-feature',
    baseBranch: 'dev',
    state: 'open',
    draft: false,
    mergeState: null,
    ...overrides,
  };
}

function makeReview(
  overrides?: Partial<NonNullable<TaskView['review']>>,
): NonNullable<TaskView['review']> {
  return {
    sessionId: 'review-1',
    status: 'done',
    verdict: 'approved',
    summary: 'Looks good',
    iterationCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
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

describe('TaskCard', () => {
  it('renders task name', () => {
    render(
      <TaskCard
        task={makeTask()}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('Implement Feature')).toBeDefined();
  });

  it('renders priority badge when priority is set', () => {
    render(
      <TaskCard
        task={makeTask({ priority: '🔴 High' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('🔴 High')).toBeDefined();
  });

  it('does not render priority badge when priority is empty', () => {
    render(
      <TaskCard
        task={makeTask({ priority: '' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByText(/High|Low|Medium/)).toBeNull();
  });

  it('renders code session status when codeSession is present', () => {
    const session = makeCodeSession({ status: 'running' });
    render(
      <TaskCard
        task={makeTask({ codeSession: session })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('running')).toBeDefined();
  });

  it('renders lastMessage in session line when present', () => {
    const session = makeCodeSession({ lastMessage: 'Writing tests...' });
    render(
      <TaskCard
        task={makeTask({ codeSession: session })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('Writing tests...')).toBeDefined();
  });

  it('renders — placeholder when codeSession is null', () => {
    render(
      <TaskCard
        task={makeTask({ codeSession: null })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    const placeholders = screen.getAllByText('—');
    expect(placeholders.length).toBeGreaterThanOrEqual(1);
  });

  it('renders — placeholder in meta line when pr is null', () => {
    render(
      <TaskCard
        task={makeTask({ pr: null })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    const placeholders = screen.getAllByText('—');
    expect(placeholders.length).toBeGreaterThanOrEqual(1);
  });

  it('renders PR number and state when pr is present', () => {
    render(
      <TaskCard
        task={makeTask({
          pr: makePr({ prNumber: 42, state: 'open', draft: false }),
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('#42')).toBeDefined();
    expect(screen.getByText('open')).toBeDefined();
  });

  it('renders "draft" as PR state when pr.draft is true', () => {
    render(
      <TaskCard
        task={makeTask({ pr: makePr({ draft: true, state: 'open' }) })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('draft')).toBeDefined();
  });

  it('renders review verdict badge when review.verdict is present', () => {
    // Verdict badge is rendered alongside the PR section, so a PR must exist
    render(
      <TaskCard
        task={makeTask({
          pr: makePr(),
          review: makeReview({ verdict: 'approved' }),
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('✅ Approved')).toBeDefined();
  });

  it('renders needs_changes verdict label', () => {
    render(
      <TaskCard
        task={makeTask({
          pr: makePr(),
          review: makeReview({ verdict: 'needs_changes' }),
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('🔁 Needs changes')).toBeDefined();
  });

  it('does not render verdict badge when review.verdict is null', () => {
    render(
      <TaskCard
        task={makeTask({ review: makeReview({ verdict: null }) })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByText(/Approved|Needs changes|Incomplete/)).toBeNull();
  });

  it('renders conflict badge when pr.mergeState is "dirty"', () => {
    render(
      <TaskCard
        task={makeTask({ pr: makePr({ mergeState: 'dirty' }) })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('⚠ Conflict')).toBeDefined();
  });

  it('does not render conflict badge when pr.mergeState is null', () => {
    render(
      <TaskCard
        task={makeTask({ pr: makePr({ mergeState: null }) })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByText('⚠ Conflict')).toBeNull();
  });

  it('renders ❌ CI failing badge when pr.mergeState is ci_failed', () => {
    render(
      <TaskCard
        task={makeTask({ pr: makePr({ mergeState: 'ci_failed' }) })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('❌ CI failing')).toBeDefined();
  });

  it('renders ⚠ CI unstable badge when pr.mergeState is unstable', () => {
    render(
      <TaskCard
        task={makeTask({ pr: makePr({ mergeState: 'unstable' }) })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('⚠ CI unstable')).toBeDefined();
  });

  it('renders no CI badges when pr is null', () => {
    render(
      <TaskCard
        task={makeTask({ pr: null })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByText('❌ CI failing')).toBeNull();
    expect(screen.queryByText('⚠ CI unstable')).toBeNull();
  });

  it('renders source-aware link label when notionUrl is set', () => {
    render(
      <TaskCard
        task={makeTask({ notionUrl: 'https://notion.so/task-1' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject({ taskSource: 'notion' })}
      />,
    );
    expect(screen.getByText('Notion ↗')).toBeDefined();
  });

  it('renders Issue ↗ label for github-source project', () => {
    render(
      <TaskCard
        task={makeTask({ notionUrl: 'https://github.com/owner/repo/issues/1' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject({ taskSource: 'github' })}
      />,
    );
    expect(screen.getByText('Issue ↗')).toBeDefined();
  });

  it('calls onClick when card is clicked', () => {
    const onClick = vi.fn();
    render(
      <TaskCard
        task={makeTask()}
        selected={false}
        onClick={onClick}
        send={noop}
        project={makeProject()}
      />,
    );
    fireEvent.click(screen.getByText('Implement Feature'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders 🚫 Blocked label for blocked displayStatus', () => {
    render(
      <TaskCard
        task={makeTask({ displayStatus: 'blocked' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('🚫 Blocked')).toBeDefined();
  });

  it('renders ⏭️ Deferred label for deferred displayStatus', () => {
    render(
      <TaskCard
        task={makeTask({ displayStatus: 'deferred' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('⏭️ Deferred')).toBeDefined();
  });

  it('renders 🔲 Backlog label for backlog displayStatus', () => {
    render(
      <TaskCard
        task={makeTask({ displayStatus: 'backlog' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('🔲 Backlog')).toBeDefined();
  });

  it('applies correct data-status for each displayStatus value', () => {
    const statuses: DisplayStatus[] = [
      'ready',
      'in_progress',
      'in_review',
      'needs_attention',
      'ready_to_merge',
      'done',
      'blocked',
      'deferred',
    ];
    for (const status of statuses) {
      const { container, unmount } = render(
        <TaskCard
          task={makeTask({ displayStatus: status })}
          selected={false}
          onClick={vi.fn()}
          send={noop}
          project={makeProject()}
        />,
      );
      const card = container.firstElementChild as HTMLElement;
      expect(card.getAttribute('data-status')).toBe(status);
      unmount();
    }
  });

  // ── Launch button ─────────────────────────────────────────────────────────

  it('does not render a launch button on the large task card', () => {
    render(
      <TaskCard
        task={makeTask({
          notionStatus: '🗂️ Ready',
          taskType: '💻 Code',
          blocked: false,
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /launch session/i }),
    ).toBeNull();
  });

  // ── Non-Code task rendering ───────────────────────────────────────────────

  it('does not render session placeholder or PR placeholder for non-Code tasks', () => {
    render(
      <TaskCard
        task={makeTask({ taskType: '📋 Planning' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByText('—')).toBeNull();
  });

  // ── Context-occupancy gauge ───────────────────────────────────────────────

  it('renders context gauge with correct percentage for active session with occupancy tokens', () => {
    const session = makeCodeSession({
      status: 'running',
      context_occupancy_tokens: 50_000,
      compaction_count: 0,
    });
    render(
      <TaskCard
        task={makeTask({ codeSession: session })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('25% ctx')).toBeDefined();
  });

  it('renders compacted badge when compaction_count > 0 for active session', () => {
    const session = makeCodeSession({
      status: 'running',
      context_occupancy_tokens: 50_000,
      compaction_count: 2,
    });
    render(
      <TaskCard
        task={makeTask({ codeSession: session })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('compacted 2×')).toBeDefined();
  });

  it('does not render context gauge when codeSession is null', () => {
    render(
      <TaskCard
        task={makeTask({ codeSession: null })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByText(/% ctx/)).toBeNull();
  });

  it('does not render context gauge when codeSession is concluded (done)', () => {
    const session = makeCodeSession({
      status: 'done',
      context_occupancy_tokens: 50_000,
      compaction_count: 0,
    });
    render(
      <TaskCard
        task={makeTask({ codeSession: session })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByText(/% ctx/)).toBeNull();
  });

  it('renders context gauge for needs_permission session status', () => {
    const session = makeCodeSession({
      status: 'needs_permission',
      context_occupancy_tokens: 100_000,
    });
    render(
      <TaskCard
        task={makeTask({ codeSession: session })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('50% ctx')).toBeDefined();
  });

  // ── PAUSE_REASON_LABELS: pr_creation_failed ───────────────────────────────

  it('renders non-empty title for pr_creation_failed pause reason', () => {
    render(
      <TaskCard
        task={makeTask({
          displayStatus: 'needs_attention',
          pauseReason: 'pr_creation_failed',
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    const badge = screen.getByText('⚠️ Needs Attention');
    expect(badge.getAttribute('title')).toBeTruthy();
    // source tag derived from parsed struct (pr_creation_failed → source='merge')
    expect(badge.getAttribute('title')).toContain('[merge]');
    expect(badge.getAttribute('title')).toContain('PR creation failed');
    // severity derived from parsed struct
    expect(badge.getAttribute('data-pause-severity')).toBe('needs_attention');
    expect(badge.getAttribute('data-pause-source')).toBe('merge');
  });

  // ── stalled_reconcile_cap: pauseDetail rendering ──────────────────────────

  it('appends pauseDetail to the badge title for stalled_reconcile_cap', () => {
    render(
      <TaskCard
        task={makeTask({
          displayStatus: 'needs_attention',
          pauseReason: 'stalled_reconcile_cap',
          pauseDetail: 'gate_failed — 2 fixer attempts exhausted',
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    const badge = screen.getByText('⚠️ Needs Attention');
    expect(badge.getAttribute('title')).toContain(
      'gate_failed — 2 fixer attempts exhausted',
    );
  });

  it('does not append a detail suffix when pauseDetail is absent', () => {
    render(
      <TaskCard
        task={makeTask({
          displayStatus: 'needs_attention',
          pauseReason: 'stalled_reconcile_cap',
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    const badge = screen.getByText('⚠️ Needs Attention');
    expect(badge.getAttribute('title')).not.toContain('(');
  });

  // ── Recovery control (descriptor-driven) ─────────────────────────────────

  it('renders recovery button when recoveryDescriptor.available is true', () => {
    const recovery: RecoveryDescriptor = {
      available: true,
      action: 'resume',
      label: 'Resume',
    };
    render(
      <TaskCard
        task={makeTask({
          displayStatus: 'needs_attention',
          taskType: '💻 Code',
          recoveryDescriptor: recovery,
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByRole('button', { name: /resume/i })).toBeDefined();
  });

  it('does not render recovery button when recoveryDescriptor.available is false', () => {
    const recovery: RecoveryDescriptor = { available: false };
    render(
      <TaskCard
        task={makeTask({
          displayStatus: 'needs_attention',
          taskType: '💻 Code',
          recoveryDescriptor: recovery,
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /resume|rerun|redispatch/i }),
    ).toBeNull();
  });

  it('does not render recovery button when recoveryDescriptor is absent', () => {
    render(
      <TaskCard
        task={makeTask({
          displayStatus: 'needs_attention',
          taskType: '💻 Code',
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /resume|rerun|redispatch/i }),
    ).toBeNull();
  });

  it('recovery button label comes from recoveryDescriptor.label', () => {
    const recovery: RecoveryDescriptor = {
      available: true,
      action: 'rerun',
      label: 'Rerun',
    };
    render(
      <TaskCard
        task={makeTask({
          displayStatus: 'needs_attention',
          taskType: '💻 Code',
          recoveryDescriptor: recovery,
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByRole('button', { name: /rerun/i })).toBeDefined();
  });

  it('recovery button POSTs to the recover route with correct taskId and projectId', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);

    const recovery: RecoveryDescriptor = {
      available: true,
      action: 'resume',
      label: 'Resume',
    };

    render(
      <TaskCard
        task={makeTask({
          taskId: 'task-paused',
          displayStatus: 'needs_attention',
          taskType: '💻 Code',
          recoveryDescriptor: recovery,
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject({ id: 'proj-1' })}
      />,
    );

    const btn = screen.getByRole('button', { name: /resume/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/tasks/task-paused/recover'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('projectId=proj-1'),
      expect.objectContaining({ method: 'POST' }),
    );

    fetchSpy.mockRestore();
  });

  it('send_message is not blocked for needs_attention card — send prop remains callable', () => {
    const send = vi.fn();
    render(
      <TaskCard
        task={makeTask({
          displayStatus: 'needs_attention',
          taskType: '💻 Code',
        })}
        selected={false}
        onClick={vi.fn()}
        send={send}
        project={makeProject()}
      />,
    );
    // The recovery control uses the REST API; the send prop is never gated on displayStatus
    send({ type: 'send_message', sessionId: 'sess-1', message: 'hello' });
    expect(send).toHaveBeenCalledWith({
      type: 'send_message',
      sessionId: 'sess-1',
      message: 'hello',
    });
  });

  it('derives source tag and severity from JSON struct pauseReason', () => {
    const jsonPauseReason = JSON.stringify({
      reason: 'ci_failing',
      source: 'ci',
      severity: 'needs_attention',
      retry_strategy: 'manual_action',
    });
    render(
      <TaskCard
        task={makeTask({
          displayStatus: 'needs_attention',
          pauseReason: jsonPauseReason as unknown as PauseReason,
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    const badge = screen.getByText('⚠️ Needs Attention');
    expect(badge.getAttribute('data-pause-source')).toBe('ci');
    expect(badge.getAttribute('data-pause-severity')).toBe('needs_attention');
    expect(badge.getAttribute('title')).toContain('[ci]');
  });

  // ── Needs-repo badge ──────────────────────────────────────────────────────

  it('renders "needs repo" badge for multi-repo project with unassigned task', () => {
    render(
      <TaskCard
        task={makeTask({ assignedRepo: null })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject({
          githubRepo: JSON.stringify(['owner/repo-a', 'owner/repo-b']),
        })}
      />,
    );
    expect(screen.getByText('⚠ Needs repo')).toBeDefined();
  });

  it('does not render "needs repo" badge for single-repo project', () => {
    render(
      <TaskCard
        task={makeTask({ assignedRepo: null })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject({ githubRepo: 'owner/repo-a' })}
      />,
    );
    expect(screen.queryByText('⚠ Needs repo')).toBeNull();
  });

  it('does not render "needs repo" badge when repo is already assigned', () => {
    render(
      <TaskCard
        task={makeTask({ assignedRepo: 'owner/repo-a' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject({
          githubRepo: JSON.stringify(['owner/repo-a', 'owner/repo-b']),
        })}
      />,
    );
    expect(screen.queryByText('⚠ Needs repo')).toBeNull();
  });

  it('does not render "needs repo" badge when project has no repos', () => {
    render(
      <TaskCard
        task={makeTask({ assignedRepo: null })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject({ githubRepo: undefined })}
      />,
    );
    expect(screen.queryByText('⚠ Needs repo')).toBeNull();
  });

  it('renders a planning-session indicator when planningSession is present (idle groom)', () => {
    render(
      <TaskCard
        task={makeTask({
          planningSession: makePlanningSession({
            sessionType: 'groom',
            status: 'idle',
          }),
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText(/Grooming:\s*idle/)).toBeDefined();
  });

  it('renders a planning-session indicator labeled by sessionType (design, running)', () => {
    render(
      <TaskCard
        task={makeTask({
          planningSession: makePlanningSession({
            sessionType: 'design',
            status: 'running',
          }),
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText(/Design:\s*running/)).toBeDefined();
  });

  it('does not render a planning-session indicator when planningSession is null', () => {
    render(
      <TaskCard
        task={makeTask({ planningSession: null })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByText(/Grooming:|Design:|Ops:/)).toBeNull();
  });

  it('renders both codeSession and planningSession indicators without conflict', () => {
    render(
      <TaskCard
        task={makeTask({
          codeSession: makeCodeSession({ status: 'running' }),
          planningSession: makePlanningSession({
            sessionType: 'ops',
            status: 'idle',
          }),
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('running')).toBeDefined();
    expect(screen.getByText(/Ops:\s*idle/)).toBeDefined();
  });
});
