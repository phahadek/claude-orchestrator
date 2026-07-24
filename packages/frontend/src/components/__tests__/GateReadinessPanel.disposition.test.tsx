import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const gateApiMock = vi.hoisted(() => ({
  listMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getGateReadiness: vi.fn().mockResolvedValue(null),
  listGateItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
  getGateItemDetail: vi.fn(),
  getVerifySessions: vi.fn().mockResolvedValue([]),
  dispatchVerification: vi
    .fn()
    .mockResolvedValue({ dispatched: [], skipped: [] }),
  recordEvent: vi.fn(),
  reopenItem: vi.fn(),
  approveItem: vi.fn(),
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

function makeItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project: 'proj-1',
    milestone: 'M12',
    text: `item ${id}`,
    classification: 'Read-Only',
    state: 'open',
    currentDisposition: undefined,
    updatedAt: '2026-01-01T00:00:00Z',
    sources: [],
    events: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gateApiMock.listMilestoneReadiness.mockResolvedValue(MILESTONES);
  gateApiMock.getGateReadiness.mockResolvedValue({
    status: 'blocked',
    blocking: [],
    counts: {},
  });
  gateApiMock.getVerifySessions.mockResolvedValue([]);
  seedApiMock.listSeedMilestoneReadiness.mockResolvedValue([]);
  seedApiMock.listSeedItems.mockResolvedValue({ items: [], total: 0, page: 1 });
  deployApiMock.getStatus.mockResolvedValue({ run: null, events: [] });
});

describe('GateReadinessPanel — operator disposition controls', () => {
  it('posts a disposition with the entered operator and re-renders the item in its new state', async () => {
    const item = makeItem('a', { state: 'open' });
    gateApiMock.listGateItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    gateApiMock.recordEvent.mockResolvedValue({
      ...item,
      state: 'pass',
      currentDisposition: 'pass',
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('item a');

    fireEvent.change(screen.getByTestId('gate-operator-input'), {
      target: { value: 'pedro@example.com' },
    });
    fireEvent.click(screen.getByTestId('gate-item-pass-a'));

    await waitFor(() => {
      expect(gateApiMock.recordEvent).toHaveBeenCalledWith('a', {
        disposition: 'pass',
        operator: 'pedro@example.com',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('gate-items-table').textContent).toContain(
        'pass',
      );
    });
  });

  it('requires a confirm before reopening a passed item, and skips the POST when declined', async () => {
    const item = makeItem('a', { state: 'pass', currentDisposition: 'pass' });
    gateApiMock.listGateItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('item a');

    fireEvent.click(screen.getByTestId('gate-item-reopen-a'));

    expect(confirmSpy).toHaveBeenCalled();
    expect(gateApiMock.reopenItem).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('reopens a passed item after confirming, posting to /reopen', async () => {
    const item = makeItem('a', { state: 'pass', currentDisposition: 'pass' });
    gateApiMock.listGateItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    gateApiMock.reopenItem.mockResolvedValue({
      ...item,
      state: 'open',
      currentDisposition: 'reopened',
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('item a');

    fireEvent.click(screen.getByTestId('gate-item-reopen-a'));

    await waitFor(() => {
      expect(gateApiMock.reopenItem).toHaveBeenCalledWith('a', {
        operator: undefined,
      });
    });

    confirmSpy.mockRestore();
  });

  it('reopens a deferred item without requiring a confirm', async () => {
    const item = makeItem('a', {
      state: 'deferred',
      currentDisposition: 'deferred',
    });
    gateApiMock.listGateItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    gateApiMock.reopenItem.mockResolvedValue({
      ...item,
      state: 'open',
      currentDisposition: 'reopened',
    });
    const confirmSpy = vi.spyOn(window, 'confirm');

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('item a');

    fireEvent.click(screen.getByTestId('gate-item-reopen-a'));

    await waitFor(() => {
      expect(gateApiMock.reopenItem).toHaveBeenCalledWith('a', {
        operator: undefined,
      });
    });
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('approves a pending-approval item, posting to /approve', async () => {
    const item = makeItem('a', {
      classification: 'Prod-Mutating',
      state: 'pending-approval',
    });
    gateApiMock.listGateItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    gateApiMock.approveItem.mockResolvedValue({
      ...item,
      state: 'pass',
      currentDisposition: 'pass',
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('item a');

    fireEvent.click(screen.getByTestId('gate-item-approve-a'));

    await waitFor(() => {
      expect(gateApiMock.approveItem).toHaveBeenCalledWith('a', {
        operator: undefined,
      });
    });
  });

  it('does not show the Approve control for items not pending approval', async () => {
    const item = makeItem('a', { state: 'open' });
    gateApiMock.listGateItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('item a');

    expect(screen.queryByTestId('gate-item-approve-a')).toBeNull();
  });
});
