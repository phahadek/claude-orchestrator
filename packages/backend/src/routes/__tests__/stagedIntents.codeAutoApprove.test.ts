/**
 * Code Ready-flip auto-commit on session completion: a fully eligible group
 * commits as the system when the per-project switch is on,
 * stays staged otherwise, and a racing operator commit becomes a no-op.
 */

import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetTaskBackend,
  mockRecordEvent,
  mockClassifyReadyProposal,
  projectDirRef,
} = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockRecordEvent: vi.fn(),
  mockClassifyReadyProposal: vi.fn(),
  projectDirRef: { value: '/nonexistent-code-auto-approve' },
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
      projectDir: projectDirRef.value,
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
      projectDir: projectDirRef.value,
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
      milestones: [{ id: 'M1', name: 'M1', canonicalShortId: 'M1' }],
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
import { logger } from '../../logger';
import { checkGroomingPromotionGate } from '../../groom/groomGate';
import {
  checkReadiness,
  standardTriageCleanDesignOverrideReason,
} from '../../tasks/readinessGate';
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
  '## Summary\nClean.\n## Files / paths affected\n- packages/backend/src/groom/codeAutoApprove.ts';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

let backend: {
  type: string;
  fetchTaskPage: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  setDependsOn: ReturnType<typeof vi.fn>;
  patchBodySection?: ReturnType<typeof vi.fn>;
};

function stageCodeGroup(
  groupId: string,
  gate: Record<string, unknown> = GOOD_GATE,
) {
  const sourceTask = {
    id: TASK,
    title: 'Some Code task',
    project: PROJECT,
    milestone: 'M1',
  };
  stageIntent(
    'gate.accrete',
    {
      sourceTask,
      items: [],
      classification: 'n/a',
      reason: 'This task type is exempt from gate accretion.',
    },
    PROJECT,
    groupId,
    SESSION,
  );
  stageIntent(
    'seed.stage',
    { sourceTask, seeds: [], decision: 'n/a' },
    PROJECT,
    groupId,
    SESSION,
  );
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
  projectDirRef.value = REPO_ROOT;
  mockRecordEvent.mockReset();
  vi.mocked(checkGroomingPromotionGate).mockImplementation(async () => ({
    allowed: true,
    reasons: [],
  }));
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
      gateCalls: vi.mocked(checkGroomingPromotionGate).mock.calls.length,
      gateResults: vi
        .mocked(checkGroomingPromotionGate)
        .mock.results.map((r) => r.type),
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

  function stagePatchMember(groupId: string) {
    stageIntent(
      'task.patchBodySection',
      {
        taskId: TASK,
        section: 'Summary',
        operation: 'append',
        content: 'More.',
      },
      PROJECT,
      groupId,
      SESSION,
    );
  }

  it('auto-commits a realistic group with accretion members under the real promotion gate', async () => {
    const actualGate = await vi.importActual<
      typeof import('../../groom/groomGate')
    >('../../groom/groomGate');
    vi.mocked(checkGroomingPromotionGate).mockImplementation(
      actualGate.checkGroomingPromotionGate,
    );
    backend.patchBodySection = vi.fn().mockResolvedValue(undefined);
    stageCodeGroup('g-real');
    stagePatchMember('g-real');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    const rows = listStagedIntentsByGroup('g-real');
    expect(
      rows.map((r) => `${r.kind}:${r.state}`).sort(),
      JSON.stringify({
        annotations: rows.map((r) => [r.kind, r.annotation]),
        logged: vi.mocked(logger.debug).mock.calls.slice(-3),
      }),
    ).toEqual(rows.map((r) => `${r.kind}:committed`).sort());
    expect(rows).toHaveLength(5);
    const events = systemCommits();
    expect(events).toHaveLength(1);
    expect(events[0].payload.provenance).toBe('auto');
  });

  it('a system commit without code-auto-approve evidence still refuses human-only members', async () => {
    stageCodeGroup('g-noev');
    const result = await commitGroupIntents('g-noev', {
      override: false,
      reason: '',
      actorType: 'system',
      autoApprove: true,
      evidence: { standard: 'other' } as never,
    });
    expect(result.status).toBe(403);
    expect(
      listStagedIntentsByGroup('g-noev')
        .filter((r) => r.kind === 'gate.accrete' || r.kind === 'seed.stage')
        .every((r) => r.state !== 'committed'),
    ).toBe(true);
  });

  it('task.setType is never auto-approved and is refused for a system apply', async () => {
    stageCodeGroup('g-type');
    stageIntent(
      'task.setType',
      { taskId: TASK, type: '💻 Code' },
      PROJECT,
      'g-type',
      SESSION,
    );
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
    const result = await commitGroupIntents('g-type', {
      override: false,
      reason: '',
      actorType: 'system',
      autoApprove: true,
      evidence: {
        standard: 'code-auto-approve',
        standardVersion: '1',
        tripwireVersion: '1',
        conditions: [],
        tripwireMatches: [],
      },
    });
    expect(result.status).toBe(403);
    expect(
      listStagedIntentsByGroup('g-type').find((r) => r.kind === 'task.setType')
        ?.state,
    ).not.toBe('committed');
  });
});

describe('autoCommitCodeReadyGroupsForSession — triage-clean types', () => {
  const TRIAGE_BODY =
    '## Summary\nClean.\n## Open Questions\nNone.\n## Targets / surfaces affected\n- x\n## Deliverables\n- y';

  async function useRealGate() {
    const actualGate = await vi.importActual<
      typeof import('../../groom/groomGate')
    >('../../groom/groomGate');
    vi.mocked(checkGroomingPromotionGate).mockImplementation(
      actualGate.checkGroomingPromotionGate,
    );
  }

  function setType(type: string) {
    backend.fetchTaskPage.mockResolvedValue(TRIAGE_BODY);
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: TASK,
      fetched_at: 0,
      raw_json: JSON.stringify({
        type,
        status: 'Not Started',
        dependsOn: [],
      }),
    });
  }

  function stageTriageGroup(
    groupId: string,
    type: string,
    verdict = 'clean',
    milestone: string | null = 'M21',
  ) {
    stageIntent(
      'task.setDependsOn',
      { taskId: TASK, dependsOn: [] },
      PROJECT,
      groupId,
      SESSION,
    );
    const row = stageIntent(
      'task.setStatus',
      {
        taskId: TASK,
        status: 'Ready',
        groomingGate: {
          type,
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
          seam_check: { decision: 'n/a' },
          triage: { proposedVerdict: verdict, hasOpenQuestionsHeading: true },
        },
      },
      PROJECT,
      groupId,
      SESSION,
    );
    db.prepare('UPDATE staged_intent SET milestone = ? WHERE group_id = ?').run(
      milestone,
      groupId,
    );
    return row;
  }

  it('commits a clean Investigation group as the system with triage-clean evidence', async () => {
    await useRealGate();
    setType('🔎 Investigation');
    stageTriageGroup('g-inv', '🔎 Investigation');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    const events = systemCommits();
    expect(events).toHaveLength(1);
    expect(events[0].payload.provenance).toBe('auto');
    expect(events[0].payload.evidence.standard).toBe('triage-clean');
  });

  it('commits a clean Design group', async () => {
    await useRealGate();
    setType('📐 Design');
    stageTriageGroup('g-design-ok', '📐 Design');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(1);
    expect(backend.updateStatus).toHaveBeenCalledTimes(1);
  });

  it('commits a Design group with the standard override reason naming the milestone short id', async () => {
    await useRealGate();
    setType('📐 Design');
    vi.mocked(checkReadiness).mockReturnValue([
      { tier: 1, message: 'open questions' } as never,
    ]);
    try {
      stageTriageGroup('g-design-ov', '📐 Design', 'clean', 'M21');
      await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    } finally {
      vi.mocked(checkReadiness).mockReturnValue([]);
    }
    expect(systemCommits()).toHaveLength(1);
    const overrides = mockRecordEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.event_type === 'readiness_override');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].payload.reason).toBe(
      standardTriageCleanDesignOverrideReason('M21'),
    );
  });

  it('commits a clean Operational group carrying gate.accrete', async () => {
    await useRealGate();
    setType('🔧 Operational');
    stageTriageGroup('g-op-ok', '🔧 Operational');
    stageIntent(
      'gate.accrete',
      {
        sourceTask: {
          id: TASK,
          title: 'Some task',
          project: PROJECT,
          milestone: 'M1',
        },
        items: [],
        classification: 'n/a',
        reason: 'This task type is exempt from gate accretion.',
      },
      PROJECT,
      'g-op-ok',
      SESSION,
    );
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(1);
    expect(
      listStagedIntentsByGroup('g-op-ok').some(
        (r) => r.kind === 'gate.accrete' && r.state === 'committed',
      ),
    ).toBe(true);
  });

  it('leaves a triage group staged when it carries task.create', async () => {
    await useRealGate();
    setType('🔎 Investigation');
    stageTriageGroup('g-tcreate', '🔎 Investigation');
    stageIntent(
      'task.create',
      { title: 'Follow-up', type: '💻 Code' } as never,
      PROJECT,
      'g-tcreate',
      SESSION,
    );
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
  });

  it('commits a clean Operational group', async () => {
    await useRealGate();
    setType('🔧 Operational');
    stageTriageGroup('g-op-ok2', '🔧 Operational');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(1);
  });

  it.each(['needs-attention', 'blocked'])(
    'leaves an Operational group staged when triage is %s',
    async (verdict) => {
      await useRealGate();
      setType('🔧 Operational');
      stageTriageGroup('g-op-v', '🔧 Operational', verdict);
      await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
      expect(systemCommits()).toHaveLength(0);
    },
  );

  it('leaves a triage group staged when the milestone cannot be resolved', async () => {
    await useRealGate();
    setType('🔎 Investigation');
    stageTriageGroup('g-nomil', '🔎 Investigation', 'clean', null);
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
  });

  it('leaves a triage group staged when the per-project switch is off', async () => {
    await useRealGate();
    db.prepare('UPDATE projects SET code_auto_approve_enabled = 0').run();
    setType('🔎 Investigation');
    stageTriageGroup('g-tsw', '🔎 Investigation');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
  });

  it('leaves a triage group staged when the session staged a decision.pickOne', async () => {
    await useRealGate();
    setType('🔎 Investigation');
    stageTriageGroup('g-tpick', '🔎 Investigation');
    db.prepare(
      `INSERT INTO staged_intent
         (id, kind, payload, payload_hash, project_id, session_id, state, created_at, updated_at)
       VALUES ('pick-t', 'decision.pickOne', '{}', 'h', ?, ?, 'staged', 1, 1)`,
    ).run(PROJECT, SESSION);
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
  });

  it('leaves a triage group staged when it carries task.setType', async () => {
    await useRealGate();
    setType('🔎 Investigation');
    stageTriageGroup('g-ttype', '🔎 Investigation');
    stageIntent(
      'task.setType',
      { taskId: TASK, type: '🔎 Investigation' },
      PROJECT,
      'g-ttype',
      SESSION,
    );
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
  });

  it('leaves a triage group staged when it removes an existing Depends On edge', async () => {
    await useRealGate();
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: TASK,
      fetched_at: 0,
      raw_json: JSON.stringify({
        type: '🔎 Investigation',
        status: 'Not Started',
        dependsOn: ['bbbbbbbbbbbb4bbbbbbbbbbbbbbbbbbb'],
      }),
    });
    backend.fetchTaskPage.mockResolvedValue(TRIAGE_BODY);
    stageTriageGroup('g-tdeps', '🔎 Investigation');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
  });
});
