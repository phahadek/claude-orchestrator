import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SessionCard, truncate } from '../SessionCard';
import { StatusBadge } from '../StatusBadge';
import type { SessionState } from '../../hooks/useSessionStore';

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: 'test-session',
    taskName: 'Test Task',
    notionTaskUrl: 'https://notion.so/task',
    status: 'running',
    events: [],
    ...overrides,
  };
}

describe('truncate', () => {
  it('returns the original string when it is within maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and appends ellipsis when string exceeds maxLen', () => {
    const long = 'a'.repeat(130);
    const result = truncate(long, 120);
    expect(result).toHaveLength(121); // 120 chars + ellipsis char
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('SessionCard', () => {
  it('renders task name and status badge', () => {
    render(<SessionCard session={makeSession()} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('Test Task')).toBeDefined();
    expect(screen.getByText('🔄 Running')).toBeDefined();
  });

  it('truncates last event content to 120 characters', () => {
    const longContent = 'x'.repeat(130);
    const session = makeSession({
      events: [{ eventType: 'text', content: longContent, timestamp: Date.now() }],
    });
    render(<SessionCard session={session} selected={false} onClick={vi.fn()} />);
    const preview = screen.getByText(/x+…/);
    expect(preview.textContent?.length).toBe(121); // 120 + ellipsis
  });

  it('renders attention indicator for needs_permission sessions', () => {
    const session = makeSession({ status: 'needs_permission' });
    render(<SessionCard session={session} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText(/needs permission/i)).toBeDefined();
  });

  it('does not render attention indicator for non-needs_permission sessions', () => {
    render(<SessionCard session={makeSession({ status: 'running' })} selected={false} onClick={vi.fn()} />);
    expect(screen.queryByText(/needs permission/i)).toBeNull();
  });

  it('renders PR link when prUrl is set (terminal session)', () => {
    const session = makeSession({ status: 'done', prUrl: 'https://github.com/pr/42' });
    render(<SessionCard session={session} selected={false} onClick={vi.fn()} />);
    const link = screen.getByText('PR ↗');
    expect(link).toBeDefined();
    expect((link as HTMLAnchorElement).href).toBe('https://github.com/pr/42');
  });

  it('does not render PR link when prUrl is not set', () => {
    render(<SessionCard session={makeSession({ status: 'running' })} selected={false} onClick={vi.fn()} />);
    expect(screen.queryByText('PR ↗')).toBeNull();
  });

  it('calls onClick when card is clicked', () => {
    const onClick = vi.fn();
    render(<SessionCard session={makeSession()} selected={false} onClick={onClick} />);
    fireEvent.click(screen.getByText('Test Task'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not render last-event section when events list is empty', () => {
    render(<SessionCard session={makeSession({ events: [] })} selected={false} onClick={vi.fn()} />);
    // No text from an event content — just task name, badge, elapsed
    expect(screen.queryByText(/^x/)).toBeNull();
  });

  it('shows total duration for done session using started_at/ended_at', () => {
    const started_at = Date.now() - 125_000; // 2m 5s ago
    const ended_at = Date.now() - 5_000;     // ended 5s ago → 2m 0s duration
    const session = makeSession({ status: 'done', started_at, ended_at });
    render(<SessionCard session={session} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('2m 0s')).toBeDefined();
  });

  it('uses started_at for running session rather than event timestamp', () => {
    // All events arrive with the same timestamp (simulating a sync burst)
    const burstTs = Date.now() - 1;
    const started_at = Date.now() - 61_000; // session started 61s ago
    const session = makeSession({
      status: 'running',
      started_at,
      events: [
        { eventType: 'text', content: 'a', timestamp: burstTs },
        { eventType: 'text', content: 'b', timestamp: burstTs },
      ],
    });
    render(<SessionCard session={session} selected={false} onClick={vi.fn()} />);
    // Should show ~61s from started_at, not < 1s from event timestamps
    expect(screen.getByText(/1m \d+s/)).toBeDefined();
  });

  it('shows — when no started_at and no events', () => {
    const session = makeSession({ status: 'running', started_at: undefined, events: [] });
    render(<SessionCard session={session} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('—')).toBeDefined();
  });
});

// ── StatusBadge — review sessionType ─────────────────────────────────────────
describe('StatusBadge', () => {
  it('renders 🔍 Review badge when sessionType is review', () => {
    render(<StatusBadge status="running" sessionType="review" />);
    expect(screen.getByText('🔍 Review')).toBeDefined();
  });

  it('renders normal status badge when sessionType is not review', () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByText('🔄 Running')).toBeDefined();
    expect(screen.queryByText('🔍 Review')).toBeNull();
  });

  it('renders 🔍 Review badge for a done review session', () => {
    render(<StatusBadge status="done" sessionType="review" />);
    expect(screen.getByText('🔍 Review')).toBeDefined();
  });
});
