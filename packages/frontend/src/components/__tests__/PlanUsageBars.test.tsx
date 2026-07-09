import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlanUsageBars } from '../PlanUsageBars';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-09T23:35:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PlanUsageBars', () => {
  it('renders nothing when usage is undefined', () => {
    const { container } = render(<PlanUsageBars usage={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when usage.available is false', () => {
    const { container } = render(
      <PlanUsageBars usage={{ available: false }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders two bars at the given percents with reset-time titles', () => {
    render(
      <PlanUsageBars
        usage={{
          available: true,
          fiveHour: {
            percent: 43,
            resetsAt: '2026-07-10T01:49:59Z',
            severity: 'normal',
          },
          weekly: {
            percent: 7,
            resetsAt: '2026-07-09T22:59:59Z',
            severity: 'normal',
          },
        }}
      />,
    );

    expect(screen.getByTestId('plan-usage-bars')).toBeTruthy();

    const hourlyBar = screen.getByTestId('plan-usage-bar-hourly');
    expect(hourlyBar.getAttribute('title')).toContain('Hourly: 43%');
    expect(hourlyBar.getAttribute('title')).toContain('resets 01:49');
    expect(hourlyBar.querySelector('div')?.getAttribute('style')).toContain(
      'width: 43%',
    );

    const weeklyBar = screen.getByTestId('plan-usage-bar-weekly');
    expect(weeklyBar.getAttribute('title')).toContain('Weekly: 7%');
    expect(weeklyBar.querySelector('div')?.getAttribute('style')).toContain(
      'width: 7%',
    );
  });
});
