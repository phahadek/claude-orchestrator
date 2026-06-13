import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskCard } from '../TaskCard';
import type {
  TaskView,
  DisplayStatus,
  PauseReason,
} from '../../types/taskView';
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
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
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

  it('applies correct data-status for each displayStatus value', () => {
    const statuses: DisplayStatus[] = [
      'ready',
      'in_progress',
      'in_review',
      'needs_attention',
      'ready_to_merge',
      'done',
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

  it('Launch button is enabled for unblocked Ready code tasks', () => {
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
    const btn = screen.getByRole('button', { name: /launch session/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('Launch button is enabled only when task status is "🗂️ Ready" and not blocked and is a code task', () => {
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
    const btn = screen.getByRole('button', { name: /launch session/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('Launch button is disabled when task is blocked', () => {
    render(
      <TaskCard
        task={makeTask({
          notionStatus: '🗂️ Ready',
          taskType: '💻 Code',
          blocked: true,
          blockerNames: ['Other Task'],
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    const btn = screen.getByRole('button', { name: /blocked by/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not render a Launch button for non-code tasks', () => {
    render(
      <TaskCard
        task={makeTask({
          notionStatus: '🗂️ Ready',
          taskType: '📋 Planning',
          blocked: false,
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('Launch button is disabled when task status is "🔄 In Progress"', () => {
    render(
      <TaskCard
        task={makeTask({
          notionStatus: '🔄 In Progress',
          displayStatus: 'in_progress',
          taskType: '💻 Code',
          blocked: false,
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    const btn = screen.getByRole('button', { name: /task is not ready/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('Launch button is disabled when task status is "👀 In Review"', () => {
    render(
      <TaskCard
        task={makeTask({
          notionStatus: '👀 In Review',
          displayStatus: 'in_review',
          taskType: '💻 Code',
          blocked: false,
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    const btn = screen.getByRole('button', { name: /task is not ready/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('Launch button dispatches single task when clicked, using taskId not notionUrl', () => {
    const send = vi.fn();
    const project = makeProject();
    const task = makeTask({
      taskId: 'task-abc',
      notionStatus: '🗂️ Ready',
      taskType: '💻 Code',
      blocked: false,
      notionUrl: 'https://notion.so/task-abc',
    });

    render(
      <TaskCard
        task={task}
        selected={false}
        onClick={vi.fn()}
        send={send}
        project={project}
      />,
    );

    const btn = screen.getByRole('button', { name: /launch session/i });
    fireEvent.click(btn);

    expect(send).toHaveBeenCalledWith({
      type: 'dispatch',
      tasks: [
        {
          taskUrl: 'task-abc',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          projectId: 'proj-1',
        },
      ],
    });
    // Verify taskId is used, not notionUrl
    const dispatchCall = send.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'dispatch',
    );
    expect(dispatchCall?.[0].tasks[0].taskUrl).toBe('task-abc');
    expect(dispatchCall?.[0].tasks[0].taskUrl).not.toBe(
      'https://notion.so/task-abc',
    );
  });

  it('Launch button click does not propagate to card onClick', () => {
    const onClick = vi.fn();
    const task = makeTask({
      notionStatus: '🗂️ Ready',
      taskType: '💻 Code',
      blocked: false,
    });

    render(
      <TaskCard
        task={task}
        selected={false}
        onClick={onClick}
        send={noop}
        project={makeProject()}
      />,
    );

    const btn = screen.getByRole('button', { name: /launch session/i });
    fireEvent.click(btn);

    expect(onClick).not.toHaveBeenCalled();
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
});
