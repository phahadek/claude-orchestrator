import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateApiMock = vi.hoisted(() => ({
  listMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getGateReadiness: vi.fn().mockResolvedValue(null),
  listGateItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
  getGateItemDetail: vi.fn(),
  getVerifySessions: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../api/gate', () => ({ gateApi: gateApiMock }));

const seedApiMock = vi.hoisted(() => ({
  listSeedMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getSeedReadiness: vi.fn().mockResolvedValue(null),
  listSeedItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
}));
vi.mock('../../api/seed', () => ({ seedApi: seedApiMock }));

const deployApiMock = vi.hoisted(() => ({
  launch: vi.fn(),
  getStatus: vi.fn().mockResolvedValue({ run: null, events: [] }),
}));
vi.mock('../../api/deploy', () => ({ deployApi: deployApiMock }));

import { GateReadinessPanel } from '../GateReadinessPanel';

const MILESTONES = [
  { project: 'proj-1', milestone: 'M12', status: 'green', blockingCount: 0 },
];

const ITEM = {
  id: 'gate-item-32addd74',
  project: 'proj-1',
  milestone: 'M12',
  text: 'a gate item with a downgraded event',
  classification: 'Read-Only',
  state: 'open',
  currentDisposition: 'needs-setup',
  updatedAt: '2026-01-01T00:00:00Z',
  sources: [],
  events: [],
};

const EVENT_WITH_EVIDENCE = {
  disposition: 'needs-setup',
  at: '2026-01-01T00:00:00Z',
  operator: 'gate-verifier',
  evidence: {
    reason:
      "pass disposition's evidence admits the live/operational record was not or could not be read — a self-reported limitation like this cannot be paired with a pass",
    reportedEvidence: {
      basis: 'operational',
      pr: '#994',
      test_execution: 'ran vitest… 4/4 passed…',
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  gateApiMock.listMilestoneReadiness.mockResolvedValue(MILESTONES);
  gateApiMock.getVerifySessions.mockResolvedValue([]);
  seedApiMock.listSeedMilestoneReadiness.mockResolvedValue([]);
  seedApiMock.listSeedItems.mockResolvedValue({ items: [], total: 0, page: 1 });
  deployApiMock.getStatus.mockResolvedValue({ run: null, events: [] });
});

describe('GateReadinessPanel — gate item event evidence', () => {
  it('surfaces the reported disposition, downgrade reason, and evidence summary for a needs-setup event', async () => {
    gateApiMock.listGateItems.mockResolvedValue({
      items: [ITEM],
      total: 1,
      page: 1,
    });
    gateApiMock.getGateItemDetail.mockResolvedValue({
      item: ITEM,
      sources: [],
      events: [EVENT_WITH_EVIDENCE],
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);

    const row = await screen.findByText('a gate item with a downgraded event');
    fireEvent.click(row);

    await waitFor(() => {
      expect(gateApiMock.getGateItemDetail).toHaveBeenCalledWith(
        'gate-item-32addd74',
      );
    });

    const evidenceSummary = await screen.findByText('Evidence');
    fireEvent.click(evidenceSummary);

    const reportedRow = screen.getByText(/Reported:/);
    expect(reportedRow.textContent).toContain('pass');
    expect(reportedRow.textContent).toContain('needs-setup');
    expect(
      screen.getByText(/live\/operational record was not or could not be read/),
    ).toBeTruthy();
    expect(screen.getByText(/basis:/)).toBeTruthy();
    expect(screen.getByText('operational')).toBeTruthy();
    expect(screen.getByText(/pr:/)).toBeTruthy();
    expect(screen.getByText('#994')).toBeTruthy();
  });

  it('renders a plain-string evidence value as prose in the event history', async () => {
    const stringEvidence =
      'Verified via manual review: the deploy log shows the migration ran cleanly against staging and the smoke tests passed.';
    gateApiMock.listGateItems.mockResolvedValue({
      items: [ITEM],
      total: 1,
      page: 1,
    });
    gateApiMock.getGateItemDetail.mockResolvedValue({
      item: ITEM,
      sources: [],
      events: [
        {
          disposition: 'pass',
          at: '2026-01-01T00:00:00Z',
          operator: 'reviewer',
          evidence: stringEvidence,
        },
      ],
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);

    const row = await screen.findByText('a gate item with a downgraded event');
    fireEvent.click(row);

    const evidenceSummary = await screen.findByText('Evidence');
    fireEvent.click(evidenceSummary);

    expect(screen.getByText(stringEvidence)).toBeTruthy();
  });

  it('renders a multi-kilobyte string evidence value inside the collapsible details', async () => {
    const longEvidence = 'a very long line of rationale text. '.repeat(50);
    expect(longEvidence.length).toBeGreaterThan(1024);

    gateApiMock.listGateItems.mockResolvedValue({
      items: [ITEM],
      total: 1,
      page: 1,
    });
    gateApiMock.getGateItemDetail.mockResolvedValue({
      item: ITEM,
      sources: [],
      events: [
        {
          disposition: 'pass',
          at: '2026-01-01T00:00:00Z',
          operator: 'reviewer',
          evidence: longEvidence,
        },
      ],
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);

    const row = await screen.findByText('a gate item with a downgraded event');
    fireEvent.click(row);

    const evidenceSummary = await screen.findByText('Evidence');
    const details = evidenceSummary.closest('details');
    expect(details).toBeTruthy();
    fireEvent.click(evidenceSummary);

    expect(details?.textContent).toContain(longEvidence.trim());
  });

  it('renders no evidence details when an event has none', async () => {
    gateApiMock.listGateItems.mockResolvedValue({
      items: [ITEM],
      total: 1,
      page: 1,
    });
    gateApiMock.getGateItemDetail.mockResolvedValue({
      item: ITEM,
      sources: [],
      events: [{ disposition: 'pass', at: '2026-01-01T00:00:00Z' }],
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);

    const row = await screen.findByText('a gate item with a downgraded event');
    fireEvent.click(row);

    await screen.findByText(/Sources/);
    expect(screen.queryByText('Evidence')).toBeNull();
  });
});
