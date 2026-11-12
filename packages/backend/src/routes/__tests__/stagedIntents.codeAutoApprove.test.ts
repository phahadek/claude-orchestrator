/**
 * Code Ready-flip auto-commit on session completion: a fully eligible group
 * commits as the system when both the global and per-project switches are on,
 * stays staged otherwise, and a racing operator commit becomes a no-op.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetTaskBackend, mockRecordEvent, mockClassifyReadyProposal } =
  vi.hoisted(() => ({
    mockGetTaskBackend: vi.fn(),
    mockRecordEvent: vi.fn(),
    mockClassifyReadyProposal: vi.fn(),
  }));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: mockRecordEvent }));
vi.mock('../../tasks/deferralClassifier', () => ({
  classifyReadyProposal: mockClassifyReadyProposal,
}));
vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});
vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return { ...actual, getTaskCache: vi.fn() };
});
vi.mock('../../groom/groomGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../groom/groomGate')>();
  return {
    ...actual,
    checkGroomingPromotionGate: vi
      .fn()
      .mockResolvedValue({ allowed: true, reasons: [] }),
  };
});
vi.mock('../../tasks/readinessGate', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../tasks/readinessGate')>();
  return { ...actual, checkReadiness: vi.fn().mockReturnValue([]) };
});
vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return {
    ...actual,
    getProjectById: (id: string) => ({
      id,
      projectDir: '/nonexistent-code-auto-approve',
      boards: [],
    }),
  };
});
vi.mock('../../logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getById: (id: string) => ({
      id,
      name: id,
      projectDir: '/nonexistent-code-auto-approve',
      contextUrl: null,
      githubRepo: null,
      taskSource: 'yaml',
      gitMode: 'local-only',
      autoLaunchEnabled: false,
      autoLaunchMilestoneId: null,
      autoMergeEnabled: false,
      codeAutoApproveEnabled: true,
      milestoneBranching: null,
      nonMilestoneSourceConfig: null,
      taskSourceConfig: null,
      dataResidencyConfirmed: false,
      baseBranch: 'dev',
      archStoreAdopted: false,
      createdAt: 0,
      updatedAt: 0,
      milestones: [],
    }),
    list: () => [],
  },
}));

import { db } from '../../db/db';
import {
  getTaskCache,
  insertProject,
  insertSession,
  listStagedIntentsByGroup,
} from '../../db/queries';
import { runtimeSettings } from '../../config';
import { logger } from '../../logger';
import {
  stageIntent,
  commitGroupIntents,
  autoCommitCodeReadyGroupsForSession,
} from '../stagedIntents';

const PROJECT = 'proj-ca';
const SESSION = 'sess-ca';
const TASK = 'aaaaaaaaaaaa4aaaaaaaaaaaaaaaaaaa';

const GOOD_GATE = {
  size_check: { decision: 'no_split', loc: 100, files: 2, loc_method: 'est' },
  type_check: { decision: 'none' },
  seam_check: { decision: 'single_seam', seams: [] },
  type: '💻 Code',
};

const BODY =
  '## Summary\nClean.\n## Files / paths affected\n- packages/backend/src/foo.ts';

let backend: {
  type: string;
  fetchTaskPage: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  setDependsOn: ReturnType<typeof vi.fn>;
};

function stageCodeGroup(
  groupId: string,
  gate: Record<string, unknown> = GOOD_GATE,
) {
  stageIntent(
    'task.setDependsOn',
    { taskId: TASK, dependsOn: [] },
    PROJECT,
    groupId,
    SESSION,
  );
  return stageIntent(
    'task.setStatus',
    { taskId: TASK, status: 'Ready', groomingGate: gate },
    PROJECT,
    groupId,
    SESSION,
  );
}

beforeEach(() => {
  mockRecordEvent.mockReset();
  mockClassifyReadyProposal.mockReset();
  mockClassifyReadyProposal.mockResolvedValue(undefined);
  backend = {
    type: 'notion',
    fetchTaskPage: vi.fn().mockResolvedValue(BODY),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
  };
  mockGetTaskBackend.mockReturnValue(backend);
  vi.mocked(getTaskCache).mockReturnValue({
    task_id: TASK,
    fetched_at: 0,
    raw_json: JSON.stringify({
      type: '💻 Code',
      status: 'Not Started',
      dependsOn: [],
    }),
  });
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM projects').run();
  insertProject({
    id: PROJECT,
    name: PROJECT,
    project_dir: '/nonexistent-code-auto-approve',
    context_url: null,
    github_repo: null,
    task_source: 'yaml',
  });
  insertSession({
    session_id: SESSION,
    task_id: TASK,
    task_url: '',
    project_context_url: '',
    project_id: PROJECT,
    status: 'done',
    started_at: 0,
    ended_at: 1,
    pr_url: null,
    worktree_path: null,
    session_type: 'groom',
  });
  runtimeSettings.code_auto_approve_enabled = true;
  db.prepare('UPDATE projects SET code_auto_approve_enabled = 1').run();
});

function systemCommits() {
  return mockRecordEvent.mock.calls
    .map((c) => c[0])
    .filter(
      (e) =>
        e.event_type === 'staged_intent_group_committed' &&
        e.actor_type === 'system',
    );
}

describe('autoCommitCodeReadyGroupsForSession', () => {
  it('auto-commits a fully eligible Code group as the system with evidence', async () => {
    stageCodeGroup('g-ok');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    const events = systemCommits();
    const diag = JSON.stringify({
      rows: listStagedIntentsByGroup('g-ok').map((r) => ({
        kind: r.kind,
        state: r.state,
        annotation: r.annotation,
        session: r.session_id,
      })),
      logged: [
        ...vi.mocked(logger.error).mock.calls,
        ...vi.mocked(logger.debug).mock.calls,
      ],
    });
    expect(events, diag).toHaveLength(1);
    expect(events[0].payload.provenance).toBe('auto');
    expect(events[0].payload.evidence.standard).toBe('code-auto-approve');
    expect(backend.updateStatus).toHaveBeenCalledTimes(1);
  });

  it('leaves the group staged when the global switch is off', async () => {
    runtimeSettings.code_auto_approve_enabled = false;
    stageCodeGroup('g-off');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
    expect(
      listStagedIntentsByGroup('g-off').every((r) => r.state !== 'committed'),
    ).toBe(true);
  });

  it('leaves the group staged when the per-project switch is off', async () => {
    db.prepare('UPDATE projects SET code_auto_approve_enabled = 0').run();
    stageCodeGroup('g-proj');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
  });

  it('leaves the group staged when the size check is over the limit', async () => {
    stageCodeGroup('g-big', {
      ...GOOD_GATE,
      size_check: { decision: 'no_split', loc: 900, files: 2, loc_method: 'e' },
    });
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
  });

  it('leaves the group staged when the session staged a decision.pickOne on another task', async () => {
    stageCodeGroup('g-pick');
    db.prepare(
      `INSERT INTO staged_intent
         (id, kind, payload, payload_hash, project_id, session_id, state, created_at, updated_at)
       VALUES ('pick-1', 'decision.pickOne', '{}', 'h', ?, ?, 'staged', 1, 1)`,
    ).run(PROJECT, SESSION);
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
  });

  it('never evaluates a non-Code Ready flip', async () => {
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: TASK,
      fetched_at: 0,
      raw_json: JSON.stringify({
        type: '📐 Design',
        status: 'Not Started',
        dependsOn: [],
      }),
    });
    stageCodeGroup('g-design', { ...GOOD_GATE, type: '📐 Design' });
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
  });

  it('an operator commit racing the auto-commit yields exactly one commit', async () => {
    stageCodeGroup('g-race');
    const auto = autoCommitCodeReadyGroupsForSession(
      SESSION,
      undefined,
      undefined,
    );
    const manual = commitGroupIntents('g-race', {
      override: false,
      reason: '',
      actorType: 'human',
      autoApprove: true,
    });
    await Promise.all([auto, manual]);
    expect(backend.updateStatus).toHaveBeenCalledTimes(1);
    const committed = mockRecordEvent.mock.calls
      .map((c) => c[0])
      .filter(
        (e) =>
          e.event_type === 'staged_intent_group_committed' &&
          e.payload.outcome === 'committed',
      );
    expect(committed).toHaveLength(1);
  });
});
