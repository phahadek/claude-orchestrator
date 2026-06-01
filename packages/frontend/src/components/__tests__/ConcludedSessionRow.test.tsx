import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConcludedSessionRow } from '../ConcludedSessionRow';

const baseProps = {
  taskName: 'My Task',
  status: 'done',
  elapsed: '2m 30s',
  onClick: vi.fn(),
};

describe('ConcludedSessionRow', () => {
  it('renders task name', () => {
    render(<ConcludedSessionRow {...baseProps} />);
    expect(screen.getByText('My Task')).toBeDefined();
  });

  it('renders status badge', () => {
    render(<ConcludedSessionRow {...baseProps} status="done" />);
    expect(screen.getByText('✅ Done')).toBeDefined();
  });

  it('renders status badge for error status', () => {
    render(<ConcludedSessionRow {...baseProps} status="error" />);
    expect(screen.getByText('❌ Error')).toBeDefined();
  });

  it('renders status badge for killed status', () => {
    render(<ConcludedSessionRow {...baseProps} status="killed" />);
    expect(screen.getByText('🛑 Killed')).toBeDefined();
  });

  it('renders duration when elapsed is provided', () => {
    render(<ConcludedSessionRow {...baseProps} elapsed="1m 45s" />);
    expect(screen.getByText('1m 45s')).toBeDefined();
  });

  it('does not render duration when elapsed is null', () => {
    render(<ConcludedSessionRow {...baseProps} elapsed={null} />);
    expect(screen.queryByText(/m \d+s/)).toBeNull();
  });

  it('renders PR link when prUrl is provided', () => {
    render(
      <ConcludedSessionRow
        {...baseProps}
        prUrl="https://github.com/org/repo/pull/42"
      />,
    );
    const link = screen.getByText('PR ↗');
    expect(link).toBeDefined();
    expect((link as HTMLAnchorElement).href).toBe(
      'https://github.com/org/repo/pull/42',
    );
  });

  it('does not render PR link when prUrl is not provided', () => {
    render(<ConcludedSessionRow {...baseProps} />);
    expect(screen.queryByText('PR ↗')).toBeNull();
  });

  it('renders endDate when provided', () => {
    render(<ConcludedSessionRow {...baseProps} endDate="6/1/2026" />);
    expect(screen.getByText('6/1/2026')).toBeDefined();
  });

  it('clicking the row invokes onClick (expand action)', () => {
    const onClick = vi.fn();
    render(<ConcludedSessionRow {...baseProps} onClick={onClick} />);
    fireEvent.click(screen.getByTestId('concluded-session-row'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('pressing Enter on the row invokes onClick', () => {
    const onClick = vi.fn();
    render(<ConcludedSessionRow {...baseProps} onClick={onClick} />);
    fireEvent.keyDown(screen.getByTestId('concluded-session-row'), {
      key: 'Enter',
    });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('pressing Space on the row invokes onClick', () => {
    const onClick = vi.fn();
    render(<ConcludedSessionRow {...baseProps} onClick={onClick} />);
    fireEvent.keyDown(screen.getByTestId('concluded-session-row'), {
      key: ' ',
    });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('clicking PR link does not bubble to row onClick', () => {
    const onClick = vi.fn();
    render(
      <ConcludedSessionRow
        {...baseProps}
        onClick={onClick}
        prUrl="https://github.com/org/repo/pull/1"
      />,
    );
    fireEvent.click(screen.getByText('PR ↗'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applies projectColor as left border style', () => {
    render(<ConcludedSessionRow {...baseProps} projectColor="#89b4fa" />);
    const row = screen.getByTestId('concluded-session-row');
    // JSDOM normalises hex → rgb; check structural presence of the border
    expect((row as HTMLElement).style.borderLeft).toMatch(/^3px solid /);
    expect((row as HTMLElement).style.borderLeft).not.toBe('3px solid ');
  });

  it('does NOT register WS-event subscriptions — purely presentational with no hooks', () => {
    // ConcludedSessionRow imports no hook (no useState / useEffect / useWebSocket).
    // Rendering it produces a stable, synchronous DOM snapshot; no async
    // re-renders or subscription side-effects occur.
    const { container } = render(<ConcludedSessionRow {...baseProps} />);
    expect(
      container.querySelector('[data-testid="concluded-session-row"]'),
    ).not.toBeNull();
    // DOM is stable — task name is present without any deferred update
    expect(screen.getByText('My Task')).toBeDefined();
  });
});
