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
    image_path: null,
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

describe('InvestigationReportSection — state filter', () => {
  it('defaults to Active, showing only draft+committed reports', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [
        makeReport({ id: 'r-draft', state: 'draft' }),
        makeReport({ id: 'r-committed', state: 'committed' }),
        makeReport({ id: 'r-resolved', state: 'resolved' }),
        makeReport({ id: 'r-abandoned', state: 'abandoned' }),
      ],
      total: 4,
      page: 1,
    });

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    await screen.findByTestId('report-card-r-draft');
    expect(screen.getByTestId('report-card-r-committed')).toBeTruthy();
    expect(screen.queryByTestId('report-card-r-resolved')).toBeNull();
    expect(screen.queryByTestId('report-card-r-abandoned')).toBeNull();
    expect(screen.getByTestId('report-filter-active').className).toContain(
      'stateTabActive',
    );
  });

  it('shows only in-flight reports, regardless of state, when Dispatched is selected', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [
        makeReport({
          id: 'r-committed-inflight',
          state: 'committed',
          inFlight: true,
        }),
        makeReport({
          id: 'r-resolved-inflight',
          state: 'resolved',
          inFlight: true,
        }),
        makeReport({
          id: 'r-committed-idle',
          state: 'committed',
          inFlight: false,
        }),
        makeReport({ id: 'r-draft-idle', state: 'draft', inFlight: false }),
      ],
      total: 4,
      page: 1,
    });

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    await screen.findByTestId('report-filter-dispatched');
    fireEvent.click(screen.getByTestId('report-filter-dispatched'));

    expect(screen.getByTestId('report-card-r-committed-inflight')).toBeTruthy();
    expect(screen.getByTestId('report-card-r-resolved-inflight')).toBeTruthy();
    expect(screen.queryByTestId('report-card-r-committed-idle')).toBeNull();
    expect(screen.queryByTestId('report-card-r-draft-idle')).toBeNull();
  });

  it('All and per-state tabs continue to work', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [
        makeReport({ id: 'r-draft', state: 'draft' }),
        makeReport({ id: 'r-committed', state: 'committed' }),
        makeReport({ id: 'r-resolved', state: 'resolved' }),
        makeReport({ id: 'r-abandoned', state: 'abandoned' }),
      ],
      total: 4,
      page: 1,
    });

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);
    await screen.findByTestId('report-card-r-draft');

    fireEvent.click(screen.getByTestId('report-filter-all'));
    expect(screen.getByTestId('report-card-r-draft')).toBeTruthy();
    expect(screen.getByTestId('report-card-r-committed')).toBeTruthy();
    expect(screen.getByTestId('report-card-r-resolved')).toBeTruthy();
    expect(screen.getByTestId('report-card-r-abandoned')).toBeTruthy();

    fireEvent.click(screen.getByTestId('report-filter-resolved'));
    expect(screen.queryByTestId('report-card-r-draft')).toBeNull();
    expect(screen.getByTestId('report-card-r-resolved')).toBeTruthy();

    fireEvent.click(screen.getByTestId('report-filter-abandoned'));
    expect(screen.queryByTestId('report-card-r-resolved')).toBeNull();
    expect(screen.getByTestId('report-card-r-abandoned')).toBeTruthy();

    fireEvent.click(screen.getByTestId('report-filter-draft'));
    expect(screen.getByTestId('report-card-r-draft')).toBeTruthy();
    expect(screen.queryByTestId('report-card-r-abandoned')).toBeNull();

    fireEvent.click(screen.getByTestId('report-filter-committed'));
    expect(screen.getByTestId('report-card-r-committed')).toBeTruthy();
    expect(screen.queryByTestId('report-card-r-draft')).toBeNull();
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

  it('shows the validation error and creates nothing when title is missing', async () => {
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

    expect(await screen.findByText('Title is required')).toBeTruthy();
    expect(createSpy).not.toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId(/^report-card-/)).toHaveLength(0);
  });

  it('files the report when only the title is populated (symptom left blank)', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
    });
    const draft = makeReport({
      id: 'r-no-symptom',
      title: 'New symptom',
      symptom_text: '',
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
    fireEvent.click(screen.getByTestId('report-draft-submit'));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(commitSpy).toHaveBeenCalledWith('r-no-symptom'));
    expect(await screen.findByTestId('report-card-r-no-symptom')).toBeTruthy();
  });

  it('saves a draft without committing when "Save draft" is clicked', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
    });
    const draft = makeReport({
      id: 'r-draft-new',
      title: 'New symptom',
      state: 'draft',
    });
    const createSpy = vi.spyOn(reportsApi, 'create').mockResolvedValue(draft);
    const commitSpy = vi.spyOn(reportsApi, 'commit');

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    await screen.findByTestId('investigation-report-section');
    fireEvent.click(screen.getByTestId('report-start-draft'));
    fireEvent.change(screen.getByTestId('report-draft-title'), {
      target: { value: 'New symptom' },
    });
    fireEvent.change(screen.getByTestId('report-draft-symptom'), {
      target: { value: 'It broke in prod' },
    });
    fireEvent.click(screen.getByTestId('report-draft-save'));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(commitSpy).not.toHaveBeenCalled();

    const card = await screen.findByTestId('report-card-r-draft-new');
    expect(card).toBeTruthy();
    expect(screen.getByTestId('report-state-r-draft-new').textContent).toBe(
      'Draft',
    );
    expect(screen.queryByTestId('report-draft-form')).toBeNull();
  });
});

describe('InvestigationReportSection — screenshot paste intake', () => {
  it('stages a pasted image for submission without inserting garbled text into the symptom field', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
    });

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    await screen.findByTestId('investigation-report-section');
    fireEvent.click(screen.getByTestId('report-start-draft'));

    const textarea = screen.getByTestId(
      'report-draft-symptom',
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'It broke in prod' } });

    const file = new File(['fake-png-bytes'], 'screenshot.png', {
      type: 'image/png',
    });
    const clipboardData = {
      items: [{ type: 'image/png', getAsFile: () => file }],
    };

    fireEvent.paste(textarea, { clipboardData });

    await screen.findByTestId('report-draft-image-preview');
    // The symptom text is untouched — the image paste didn't leak garbled
    // binary/base64 text into the textarea alongside the staged image.
    expect(textarea.value).toBe('It broke in prod');
  });

  it('ignores a plain-text paste, leaving normal text-paste behaviour intact', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
    });

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    await screen.findByTestId('investigation-report-section');
    fireEvent.click(screen.getByTestId('report-start-draft'));

    const textarea = screen.getByTestId('report-draft-symptom');
    const clipboardData = {
      items: [{ type: 'text/plain', getAsFile: () => null }],
    };

    fireEvent.paste(textarea, { clipboardData });

    expect(screen.queryByTestId('report-draft-image-preview')).toBeNull();
  });

  it('includes the staged image when the report is submitted', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
    });
    const draft = makeReport({
      id: 'r-with-image',
      title: 'New symptom',
      state: 'draft',
      image_path: '/data/investigation-report-images/r-with-image.png',
    });
    const committed = { ...draft, state: 'committed' as const };
    const createSpy = vi.spyOn(reportsApi, 'create').mockResolvedValue(draft);
    vi.spyOn(reportsApi, 'commit').mockResolvedValue(committed);

    render(<InvestigationReportSection projectId="proj-1" milestone="M1" />);

    await screen.findByTestId('investigation-report-section');
    fireEvent.click(screen.getByTestId('report-start-draft'));
    fireEvent.change(screen.getByTestId('report-draft-title'), {
      target: { value: 'New symptom' },
    });

    const textarea = screen.getByTestId('report-draft-symptom');
    const file = new File(['fake-png-bytes'], 'screenshot.png', {
      type: 'image/png',
    });
    fireEvent.paste(textarea, {
      clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] },
    });
    await screen.findByTestId('report-draft-image-preview');

    fireEvent.click(screen.getByTestId('report-draft-submit'));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    const call = createSpy.mock.calls[0][0];
    expect(call.image).toMatch(/^data:image\/png;base64,/);
  });
});

describe('InvestigationReportSection — Ctrl+Enter shortcut', () => {
  it('files the report when pressing Ctrl+Enter in the title input', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
    });
    const draft = makeReport({
      id: 'r-shortcut',
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
    fireEvent.keyDown(screen.getByTestId('report-draft-title'), {
      key: 'Enter',
      ctrlKey: true,
    });

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(commitSpy).toHaveBeenCalledWith('r-shortcut'));
    expect(await screen.findByTestId('report-card-r-shortcut')).toBeTruthy();
  });

  it('files the report when pressing Cmd+Enter in the symptom textarea', async () => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
    });
    const draft = makeReport({
      id: 'r-shortcut-2',
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
    fireEvent.keyDown(screen.getByTestId('report-draft-symptom'), {
      key: 'Enter',
      metaKey: true,
    });

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(commitSpy).toHaveBeenCalledWith('r-shortcut-2'));
    expect(await screen.findByTestId('report-card-r-shortcut-2')).toBeTruthy();
  });

  it('shows the validation error and creates nothing on Ctrl+Enter when title is blank', async () => {
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
    fireEvent.keyDown(screen.getByTestId('report-draft-title'), {
      key: 'Enter',
      ctrlKey: true,
    });

    expect(await screen.findByText('Title is required')).toBeTruthy();
    expect(createSpy).not.toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId(/^report-card-/)).toHaveLength(0);
  });
});
