/**
 * Tests for InvestigationReportSection.tsx.
 *
 * AC: a dispatched report's card renders a session-view affordance (not
 * just the static "● dispatched" badge), and activating it fires the
 * app-wide 'selectSession' navigation event with the dispatched session's
 * id — mirroring GateReadinessPanel's jumpToSession precedent.
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InvestigationReportSection } from '../InvestigationReportSection';
import { reportsApi } from '../../api/reports';
import type { InvestigationReport } from '../../api/reports';

function makeReport(
  overrides: Partial<InvestigationReport> & { id: string },
): InvestigationReport {
  return {
    project_id: 'proj-1',
    milestone_id: 'M1',
    title: 'Untitled report',
    symptom_text: 'Something looked wrong',
    evidence_text: null,
    state: 'committed',
    source: 'operator',
    origin_session_id: null,
    origin_task_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    inFlight: false,
    resolveEligible: false,
    dispatchedSessions: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InvestigationReportSection — dispatched session affordance', () => {
  it('renders no session-view affordance for a report with no dispatch history', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [makeReport({ id: 'r1' })],
      total: 1,
      page: 1,
    });

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    await screen.findByTestId('report-card-r1');
    expect(screen.queryByTestId('report-view-session-r1')).toBeNull();
  });

  it('renders a session-view affordance for an in-flight dispatched report, and clicking it fires selectSession', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [
        makeReport({
          id: 'r1',
          inFlight: true,
          dispatchedSessions: [
            {
              sessionId: 'sess-running',
              sessionStatus: 'running',
              dispatchedAt: '2026-01-01T00:00:01Z',
            },
          ],
        }),
      ],
      total: 1,
      page: 1,
    });

    const listener = vi.fn();
    window.addEventListener('selectSession', listener);

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    const button = await screen.findByTestId('report-view-session-r1');
    expect(button.textContent).toContain('running');

    fireEvent.click(button);

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    const event = listener.mock.calls[0][0] as CustomEvent<{
      sessionId: string;
    }>;
    expect(event.detail.sessionId).toBe('sess-running');

    window.removeEventListener('selectSession', listener);
  });

  it('renders a session-view affordance for a report whose dispatched session has ended (terminal)', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [
        makeReport({
          id: 'r2',
          inFlight: false,
          resolveEligible: true,
          dispatchedSessions: [
            {
              sessionId: 'sess-done',
              sessionStatus: 'done',
              dispatchedAt: '2026-01-01T00:00:01Z',
            },
          ],
        }),
      ],
      total: 1,
      page: 1,
    });

    const listener = vi.fn();
    window.addEventListener('selectSession', listener);

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    const button = await screen.findByTestId('report-view-session-r2');
    expect(button.textContent).toContain('done');

    fireEvent.click(button);

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    const event = listener.mock.calls[0][0] as CustomEvent<{
      sessionId: string;
    }>;
    expect(event.detail.sessionId).toBe('sess-done');

    window.removeEventListener('selectSession', listener);
  });
});
