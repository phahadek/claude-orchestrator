import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  reclassifyItem: vi.fn(),
}));
vi.mock('../../api/gate', () => ({ gateApi: gateApiMock }));

const seedApiMock = vi.hoisted(() => ({
  listSeedMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getSeedReadiness: vi.fn().mockResolvedValue(null),
  listSeedItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
  recordSeedItemEvent: vi.fn(),
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

function makeSeedItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project: 'proj-1',
    milestone: 'M12',
    spec: `seed ${id}`,
    state: 'pending',
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
  gateApiMock.listGateItems.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
  });
  gateApiMock.getVerifySessions.mockResolvedValue([]);
  seedApiMock.listSeedMilestoneReadiness.mockResolvedValue([]);
  seedApiMock.getSeedReadiness.mockResolvedValue({
    status: 'blocked',
    blocking: [],
    counts: {},
  });
  seedApiMock.listSeedItems.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
  });
  deployApiMock.getStatus.mockResolvedValue({ run: null, events: [] });
});

describe('GateReadinessPanel — seed item disposition controls', () => {
  it('posts an applied outcome with the entered operator and re-renders the item in its new state', async () => {
    const item = makeSeedItem('s1', { state: 'pending' });
    seedApiMock.listSeedItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    seedApiMock.recordSeedItemEvent.mockResolvedValue({
      ...item,
      state: 'applied',
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('seed s1');

    fireEvent.change(screen.getByTestId('gate-operator-input'), {
      target: { value: 'pedro@example.com' },
    });
    fireEvent.click(screen.getByTestId('seed-item-applied-s1'));

    await waitFor(() => {
      expect(seedApiMock.recordSeedItemEvent).toHaveBeenCalledWith('s1', {
        outcome: 'applied',
        filedFollowon: undefined,
        operator: 'pedro@example.com',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('seed-items-table').textContent).toContain(
        'applied',
      );
    });

    await waitFor(() => {
      expect(seedApiMock.getSeedReadiness).toHaveBeenCalledWith(
        'proj-1',
        'M12',
      );
    });
  });

  it('posts a confirmed outcome', async () => {
    const item = makeSeedItem('s1', { state: 'applied' });
    seedApiMock.listSeedItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    seedApiMock.recordSeedItemEvent.mockResolvedValue({
      ...item,
      state: 'confirmed',
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('seed s1');

    fireEvent.click(screen.getByTestId('seed-item-confirmed-s1'));

    await waitFor(() => {
      expect(seedApiMock.recordSeedItemEvent).toHaveBeenCalledWith('s1', {
        outcome: 'confirmed',
        filedFollowon: undefined,
        operator: undefined,
      });
    });
  });

  it('prompts for a follow-on task before posting a blocked outcome, and skips the POST when declined', async () => {
    const item = makeSeedItem('s1', { state: 'pending' });
    seedApiMock.listSeedItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('seed s1');

    fireEvent.click(screen.getByTestId('seed-item-blocked-s1'));

    expect(promptSpy).toHaveBeenCalled();
    expect(seedApiMock.recordSeedItemEvent).not.toHaveBeenCalled();

    promptSpy.mockRestore();
  });

  it('posts a blocked outcome with the prompted follow-on task id', async () => {
    const item = makeSeedItem('s1', { state: 'pending' });
    seedApiMock.listSeedItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    seedApiMock.recordSeedItemEvent.mockResolvedValue({
      ...item,
      state: 'blocked',
    });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('TASK-42');

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('seed s1');

    fireEvent.click(screen.getByTestId('seed-item-blocked-s1'));

    await waitFor(() => {
      expect(seedApiMock.recordSeedItemEvent).toHaveBeenCalledWith('s1', {
        outcome: 'blocked',
        filedFollowon: 'TASK-42',
        operator: undefined,
      });
    });

    promptSpy.mockRestore();
  });

  it('surfaces the server error on a rejected disposition without changing the item state', async () => {
    const item = makeSeedItem('s1', { state: 'pending' });
    seedApiMock.listSeedItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    seedApiMock.recordSeedItemEvent.mockRejectedValue(
      new Error('seed_item s1: invalid transition'),
    );

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('seed s1');

    fireEvent.click(screen.getByTestId('seed-item-applied-s1'));

    await waitFor(() => {
      expect(screen.getByTestId('seed-disposition-error').textContent).toBe(
        'seed_item s1: invalid transition',
      );
    });

    expect(screen.getByTestId('seed-items-table').textContent).toContain(
      'pending',
    );
  });

  it('leaves existing gate-item behaviour unchanged', async () => {
    const gateItem = {
      id: 'g1',
      project: 'proj-1',
      milestone: 'M12',
      text: 'gate item g1',
      classification: 'Read-Only',
      state: 'open',
      currentDisposition: undefined,
      updatedAt: '2026-01-01T00:00:00Z',
      sources: [],
      events: [],
    };
    gateApiMock.listGateItems.mockResolvedValue({
      items: [gateItem],
      total: 1,
      page: 1,
    });
    gateApiMock.recordEvent.mockResolvedValue({
      ...gateItem,
      state: 'pass',
      currentDisposition: 'pass',
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('gate item g1');

    fireEvent.click(screen.getByTestId('gate-item-pass-g1'));

    await waitFor(() => {
      expect(gateApiMock.recordEvent).toHaveBeenCalledWith('g1', {
        disposition: 'pass',
        operator: undefined,
      });
    });
  });
});
