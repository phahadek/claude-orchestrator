/**
 * Tests for InvestigationReportSection.tsx.
 *
 * AC: a dispatched report's card is selectable as a whole — like every
 * other milestone decision card — and clicking it fires onSelectReport with
 * that report, rather than a bespoke "View session" button dispatching a
 * global navigation event.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

describe('InvestigationReportSection — filing a report is a single action', () => {
  it('creates and commits the report in one click, rendering exactly one committed card', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
    });
    const draft = makeReport({
      id: 'r-new',
      title: 'New symptom',
      state: 'draft',
    });
    const committed = { ...draft, state: 'committed' as const };
    const createSpy = vi.spyOn(reportsApi, 'create').mockResolvedValue(draft);
    const commitSpy = vi
      .spyOn(reportsApi, 'commit')
      .mockResolvedValue(committed);

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    await screen.findByTestId('investigation-report-section');
    fireEvent.click(screen.getByTestId('report-start-draft'));
    fireEvent.change(screen.getByTestId('report-draft-title'), {
      target: { value: 'New symptom' },
    });
    fireEvent.change(screen.getByTestId('report-draft-symptom'), {
      target: { value: 'It broke in prod' },
    });
    fireEvent.click(screen.getByTestId('report-draft-submit'));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(commitSpy).toHaveBeenCalledWith('r-new'));

    const card = await screen.findByTestId('report-card-r-new');
    expect(card).toBeTruthy();
    expect(screen.getByTestId('report-state-r-new').textContent).toBe(
      'Committed',
    );
    expect(screen.queryAllByTestId(/^report-card-/)).toHaveLength(1);
  });

  it('does not call create when Cancel is clicked before submission', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
    });
    const createSpy = vi.spyOn(reportsApi, 'create');

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    await screen.findByTestId('investigation-report-section');
    fireEvent.click(screen.getByTestId('report-start-draft'));
    fireEvent.change(screen.getByTestId('report-draft-title'), {
      target: { value: 'New symptom' },
    });
    fireEvent.click(screen.getByTestId('report-draft-cancel'));

    expect(createSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('report-draft-title')).toBeNull();
  });

  it('shows the validation error and creates nothing when title/symptom are missing', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
    });
    const createSpy = vi.spyOn(reportsApi, 'create');
    const commitSpy = vi.spyOn(reportsApi, 'commit');

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    await screen.findByTestId('investigation-report-section');
    fireEvent.click(screen.getByTestId('report-start-draft'));
    fireEvent.click(screen.getByTestId('report-draft-submit'));

    expect(
      await screen.findByText('Title and symptom are both required'),
    ).toBeTruthy();
    expect(createSpy).not.toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId(/^report-card-/)).toHaveLength(0);
  });
});
