import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { recordEvent } from '../AuditLog';
import { deriveCapabilityProvenance } from '../capabilityProvenance';

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
});

describe('deriveCapabilityProvenance', () => {
  it('classifies a capability with an auto_approved disposition as auto', () => {
    recordEvent({
      event_type: 'capability_request_disposition',
      actor_type: 'system',
      actor_id: 'sess-1',
      payload: {
        capability: 'session.readOwnRecord(sess-1)',
        disposition: 'auto_approved',
        provenance: 'auto',
      },
    });

    const result = deriveCapabilityProvenance('sess-1', [
      'session.readOwnRecord(sess-1)',
    ]);

    expect(result).toEqual([
      { capability: 'session.readOwnRecord(sess-1)', provenance: 'auto' },
    ]);
  });

  it('classifies a capability with an operator_approved disposition as operator', () => {
    recordEvent({
      event_type: 'capability_request_disposition',
      actor_type: 'human',
      actor_id: 'sess-2',
      payload: {
        capability: 'Bash(psql:*)',
        disposition: 'operator_approved',
        provenance: 'operator',
      },
    });

    const result = deriveCapabilityProvenance('sess-2', ['Bash(psql:*)']);

    expect(result).toEqual([
      { capability: 'Bash(psql:*)', provenance: 'operator' },
    ]);
  });

  it('defaults to operator when no matching disposition entry exists', () => {
    const result = deriveCapabilityProvenance('sess-3', ['Bash(git:*)']);

    expect(result).toEqual([
      { capability: 'Bash(git:*)', provenance: 'operator' },
    ]);
  });

  it('ignores non-approved dispositions (declined/operator_denied) for the default fallback', () => {
    recordEvent({
      event_type: 'capability_request_disposition',
      actor_type: 'human',
      actor_id: 'sess-4',
      payload: {
        capability: 'Bash(rm:*)',
        disposition: 'operator_denied',
        provenance: 'operator',
      },
    });

    const result = deriveCapabilityProvenance('sess-4', ['Bash(rm:*)']);

    expect(result).toEqual([
      { capability: 'Bash(rm:*)', provenance: 'operator' },
    ]);
  });
});
