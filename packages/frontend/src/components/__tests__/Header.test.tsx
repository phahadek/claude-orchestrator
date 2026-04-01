import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Header } from '../Header';

describe('Header', () => {
  const defaultProps = {
    projects: [],
    activeProjectId: null,
    onProjectChange: vi.fn(),
    activeView: 'sessions' as const,
    onViewChange: vi.fn(),
  };

  it('renders Sessions and PRs nav links', () => {
    render(<Header {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Sessions' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'PRs' })).toBeDefined();
  });

  it('calls onViewChange with sessions when Sessions link is clicked', () => {
    const onViewChange = vi.fn();
    render(<Header {...defaultProps} onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(onViewChange).toHaveBeenCalledWith('sessions');
  });

  it('calls onViewChange with prs when PRs link is clicked', () => {
    const onViewChange = vi.fn();
    render(<Header {...defaultProps} onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'PRs' }));
    expect(onViewChange).toHaveBeenCalledWith('prs');
  });
});
