import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Header } from '../Header';

describe('Header', () => {
  const defaultProps = {
    projects: [],
    activeProjectId: null,
    onProjectChange: vi.fn(),
    prPanelVisible: false,
    onTogglePrPanel: vi.fn(),
  };

  it('renders PRs nav button', () => {
    render(<Header {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'PRs' })).toBeDefined();
  });

  it('calls onTogglePrPanel when PRs button is clicked', () => {
    const onTogglePrPanel = vi.fn();
    render(<Header {...defaultProps} onTogglePrPanel={onTogglePrPanel} />);
    fireEvent.click(screen.getByRole('button', { name: 'PRs' }));
    expect(onTogglePrPanel).toHaveBeenCalled();
  });
});
