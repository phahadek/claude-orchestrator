import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { describeTestRequestFailure } from '../stagedIntents';

describe('describeTestRequestFailure', () => {
  it('never renders "crashed" for a passed prior run', () => {
    for (const reason of [null, 'timeout', 'execution_failed'] as const) {
      expect(describeTestRequestFailure(reason, 'passed')).not.toContain(
        'crashed',
      );
    }
  });

  it('still says "crashed" for an unattributed failed run', () => {
    expect(describeTestRequestFailure(null, 'failed')).toBe('crashed');
  });
});
