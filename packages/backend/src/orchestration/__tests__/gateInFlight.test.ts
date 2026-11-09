import { describe, it, expect } from 'vitest';
import { withGateInFlight } from '../gateInFlight';

describe('gateInFlight', () => {
  it('holds waiters until the in-flight stage settles', async () => {
    let finish!: () => void;
    const stage = withGateInFlight(
      '/wt',
      () => new Promise<void>((r) => (finish = r)),
    );
    let waited = false;
    const waiter = withGateInFlight('/wt', async () => {
      waited = true;
    });
    await Promise.resolve();
    expect(waited).toBe(false);
    finish();
    await stage;
    await waiter;
    expect(waited).toBe(true);
  });

  it('does not block other worktrees and releases on throw', async () => {
    await expect(
      withGateInFlight('/a', async () => {
        await withGateInFlight('/b', async () => undefined);
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    await withGateInFlight('/a', async () => undefined);
  });
});
