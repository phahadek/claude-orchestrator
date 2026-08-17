import { describe, it, expect } from 'vitest';
import { WalCheckpointJob } from '../WalCheckpointJob.js';

describe('WalCheckpointJob', () => {
  it('runs a TRUNCATE checkpoint and reports wal bytes freed without throwing', () => {
    const job = new WalCheckpointJob();
    const result = job.checkpointOnce();
    expect(result).toHaveProperty('items_processed');
    expect(result.items_processed).toBeGreaterThanOrEqual(0);
  });

  it('registers as a scheduler job named wal_checkpoint', () => {
    const registered: { name: string }[] = [];
    const fakeScheduler = {
      register: (opts: { name: string }) => registered.push(opts),
    } as unknown as import('../Scheduler.js').Scheduler;

    new WalCheckpointJob().register(fakeScheduler);
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('wal_checkpoint');
  });
});
