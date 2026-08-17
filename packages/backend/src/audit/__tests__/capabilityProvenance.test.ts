import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const getProjectByIdMock = vi.fn();
vi.mock('../../config', () => ({
  getProjectById: (...args: unknown[]) => getProjectByIdMock(...args),
}));

const loadOrchestratorConfigMock = vi.fn();
vi.mock('../../session/orchestrator-config', async () => {
  const actual = await vi.importActual<
    typeof import('../../session/orchestrator-config')
  >('../../session/orchestrator-config');
  return {
    ...actual,
    loadOrchestratorConfig: (...args: unknown[]) =>
      loadOrchestratorConfigMock(...args),
  };
});

import { db } from '../../db/db';
import { recordEvent } from '../AuditLog';
import { insertSession } from '../../db/queries';
import { deriveCapabilityProvenance } from '../capabilityProvenance';

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  getProjectByIdMock.mockReset();
  loadOrchestratorConfigMock.mockReset();
  loadOrchestratorConfigMock.mockReturnValue({ capability_pre_grants: {} });
});

function seedSession(
  sessionId: string,
  opts: {
    sessionType?: string;
    projectId?: string | null;
    taskId?: string | null;
  } = {},
): void {
  insertSession({
    session_id: sessionId,
    task_id: opts.taskId ?? null,
    task_url: null,
    project_context_url: null,
    project_id: opts.projectId ?? null,
    status: 'running',
    started_at: 0,
    session_type: opts.sessionType ?? 'ops',
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
  } as never);
}

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

  it("classifies a capability present in the session's resolved pre-grant list as config, even with zero matching audit-log rows", () => {
    seedSession('sess-5', {
      sessionType: 'ops',
      projectId: 'proj-1',
      taskId: 'task:normal',
    });
    getProjectByIdMock.mockReturnValue({ projectDir: '/repo' });
    loadOrchestratorConfigMock.mockReturnValue({
      capability_pre_grants: { ops: ['Bash(git log:*)'] },
    });

    const result = deriveCapabilityProvenance('sess-5', ['Bash(git log:*)']);

    expect(result).toEqual([
      { capability: 'Bash(git log:*)', provenance: 'config' },
    ]);
  });

  it('classifies a config-pre-granted capability as config even when it also has an operator_approved audit-log entry', () => {
    seedSession('sess-6', {
      sessionType: 'ops',
      projectId: 'proj-1',
      taskId: 'task:normal',
    });
    getProjectByIdMock.mockReturnValue({ projectDir: '/repo' });
    loadOrchestratorConfigMock.mockReturnValue({
      capability_pre_grants: { ops: ['Bash(git log:*)'] },
    });
    recordEvent({
      event_type: 'capability_request_disposition',
      actor_type: 'human',
      actor_id: 'sess-6',
      payload: {
        capability: 'Bash(git log:*)',
        disposition: 'operator_approved',
        provenance: 'operator',
      },
    });

    const result = deriveCapabilityProvenance('sess-6', ['Bash(git log:*)']);

    expect(result).toEqual([
      { capability: 'Bash(git log:*)', provenance: 'config' },
    ]);
  });

  it('does not classify a capability as config when the session has no matching pre-grant', () => {
    seedSession('sess-7', {
      sessionType: 'ops',
      projectId: 'proj-1',
      taskId: 'task:normal',
    });
    getProjectByIdMock.mockReturnValue({ projectDir: '/repo' });
    loadOrchestratorConfigMock.mockReturnValue({
      capability_pre_grants: { ops: ['Bash(git log:*)'] },
    });

    const result = deriveCapabilityProvenance('sess-7', ['Bash(psql:*)']);

    expect(result).toEqual([
      { capability: 'Bash(psql:*)', provenance: 'operator' },
    ]);
  });
});
