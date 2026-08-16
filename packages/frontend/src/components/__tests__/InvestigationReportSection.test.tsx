/**
 * Tests for InvestigationReportSection.tsx.
 *
 * AC: a dispatched report's card is selectable as a whole — like every
 * other milestone decision card — and clicking it fires onSelectReport with
 * that report, rather than a bespoke "View session" button dispatching a
 * global navigation event.
 */

import { render, screen, fireEvent } from '@testing-library/react';
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

describe('InvestigationReportSection — card selection', () => {
  it('renders no "View session" button for a report with no dispatch history', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [makeReport({ id: 'r1' })],
      total: 1,
      page: 1,
    });

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    await screen.findByTestId('report-card-r1');
    expect(screen.queryByTestId('report-view-session-r1')).toBeNull();
  });

  it("fires onSelectReport with the report when clicking an in-flight dispatched report's card", async () => {
    const report = makeReport({
      id: 'r1',
      inFlight: true,
      dispatchedSessions: [
        {
          sessionId: 'sess-running',
          sessionStatus: 'running',
          dispatchedAt: '2026-01-01T00:00:01Z',
        },
      ],
    });
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [report],
      total: 1,
      page: 1,
    });

    const onSelectReport = vi.fn();
    render(
      <InvestigationReportSection
        projectId="proj-1"
        milestone="M1"
        onSelectReport={onSelectReport}
      />,
    );

    const card = await screen.findByTestId('report-card-r1');
    expect(screen.queryByTestId('report-view-session-r1')).toBeNull();

    fireEvent.click(card);

    expect(onSelectReport).toHaveBeenCalledTimes(1);
    expect(onSelectReport).toHaveBeenCalledWith(report);
  });

  it('fires onSelectReport when clicking a report card whose dispatched session has ended (terminal)', async () => {
    const report = makeReport({
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
    });
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [report],
      total: 1,
      page: 1,
    });

    const onSelectReport = vi.fn();
    render(
      <InvestigationReportSection
        projectId="proj-1"
        milestone="M1"
        onSelectReport={onSelectReport}
      />,
    );

    const card = await screen.findByTestId('report-card-r2');
    fireEvent.click(card);

    expect(onSelectReport).toHaveBeenCalledWith(report);
  });

  it('does not fire onSelectReport when clicking the commit/abandon action buttons', async () => {
    const report = makeReport({ id: 'r3', state: 'draft' });
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [report],
      total: 1,
      page: 1,
    });
    vi.spyOn(reportsApi, 'commit').mockResolvedValue({
      ...report,
      state: 'committed',
    });

    const onSelectReport = vi.fn();
    render(
      <InvestigationReportSection
        projectId="proj-1"
        milestone="M1"
        onSelectReport={onSelectReport}
      />,
    );

    const commitButton = await screen.findByTestId('report-commit-r3');
    fireEvent.click(commitButton);

    expect(onSelectReport).not.toHaveBeenCalled();
  });
});
