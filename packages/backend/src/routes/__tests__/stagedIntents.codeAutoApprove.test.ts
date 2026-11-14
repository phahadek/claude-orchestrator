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
vi.mock('../../audit/AuditLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audit/AuditLog')>();
  return { ...actual, recordEvent: mockRecordEvent };
});
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

import express from 'express';
import supertest from 'supertest';
import { queryAuditLogByProject } from '../../audit/AuditLog';
import { db } from '../../db/db';
import {
  getTaskCache,
  insertProject,
  insertSession,
  hasOpenDecisionPickOneForStagingSession,
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
  createStagedIntentsRouter,
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

  it('leaves the group staged when the body declares no parseable files section', async () => {
    backend.fetchTaskPage.mockResolvedValue('## Summary\nNo files listed.');
    stageCodeGroup('g-nopaths');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(0);
  });

  it('commits when the body mentions tripwire words but the paths are innocuous', async () => {
    backend.fetchTaskPage.mockResolvedValue(
      `${BODY}\n\nLocked by Design task X. Failing closed on timeout.`,
    );
    stageCodeGroup('g-prose');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(1);
    expect(systemCommits()[0].payload.evidence.tripwireVersion).toBe('4');
    expect(systemCommits()[0].payload.evidence.standardVersion).toBe('3');
  });

  it.each(['staged', 'approved'])(
    'reports an open %s pickOne as true',
    (state) => {
      db.prepare(
        `INSERT INTO staged_intent
           (id, kind, payload, payload_hash, project_id, session_id, state, created_at, updated_at)
         VALUES ('pick-open', 'decision.pickOne', '{}', 'h', ?, ?, ?, 1, 1)`,
      ).run(PROJECT, SESSION, state);
      expect(hasOpenDecisionPickOneForStagingSession(SESSION)).toBe(true);
    },
  );

  it.each(['committed', 'rejected', 'withdrawn', 'superseded'])(
    'reports a %s pickOne as not open, and the Code group auto-commits',
    async (state) => {
      stageCodeGroup('g-answered');
      db.prepare(
        `INSERT INTO staged_intent
           (id, kind, payload, payload_hash, project_id, session_id, state, created_at, updated_at)
         VALUES ('pick-done', 'decision.pickOne', '{}', 'h', ?, ?, ?, 1, 1)`,
      ).run(PROJECT, SESSION, state);
      expect(hasOpenDecisionPickOneForStagingSession(SESSION)).toBe(false);
      await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
      expect(systemCommits()).toHaveLength(1);
    },
  );

  it('leaves the group staged when the size check is over the limit', async () => {
    stageCodeGroup('g-big', {
      ...GOOD_GATE,
      size_check: {
        decision: 'no_split',
        loc: 1900,
        files: 2,
        loc_method: 'e',
      },
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

describe('auto_approve_skipped records', () => {
  const BIG_GATE = {
    ...GOOD_GATE,
    size_check: {
      decision: 'no_split',
      loc: 1450,
      files: 2,
      loc_method: 'est',
    },
  };

  function skipRows() {
    return queryAuditLogByProject(PROJECT, {
      eventType: 'auto_approve_skipped',
    }).entries.map((e) => e.payload as Record<string, any>);
  }

  async function listApi() {
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter());
    const res = await supertest(app).get(
      `/api/staged-intents?projectId=${PROJECT}`,
    );
    return (res.body.intents ?? res.body) as Array<Record<string, any>>;
  }

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../../audit/AuditLog')>(
      '../../audit/AuditLog',
    );
    mockRecordEvent.mockImplementation(actual.recordEvent);
    db.prepare('DELETE FROM audit_log').run();
  });

  it('records one ineligible row, dedups an unchanged verdict, and re-records a changed one', async () => {
    stageCodeGroup('g-skip', BIG_GATE);
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    let rows = skipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('ineligible');
    expect(rows[0].standard).toBe('code-auto-approve');
    expect(rows[0].group_id).toBe('g-skip');
    const size = rows[0].conditions.find((c: any) => c.id === 'size');
    expect(size.passed).toBe(false);
    expect(size.value.loc).toBe(1450);

    const api = await listApi();
    const armed = api.find(
      (r) => r.groupId === 'g-skip' && r.kind === 'task.setStatus',
    );
    expect(armed?.autoApproveVerdict.failed[0]).toMatchObject({ id: 'size' });
    expect(armed?.autoApproveVerdict.thresholds).toEqual({
      maxLoc: 1000,
      maxFiles: 40,
    });

    const armingRow = listStagedIntentsByGroup('g-skip').find(
      (r) => r.kind === 'task.setStatus',
    )!;
    const payload = JSON.parse(armingRow.payload);
    payload.groomingGate.size_check.loc = 1500;
    db.prepare('UPDATE staged_intent SET payload = ? WHERE id = ?').run(
      JSON.stringify(payload),
      armingRow.id,
    );
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    rows = skipRows();
    expect(rows).toHaveLength(2);
  });

  it('exposes null for a never-evaluated group', async () => {
    stageCodeGroup('g-never');
    const api = await listApi();
    expect(
      api
        .filter((r) => r.groupId === 'g-never')
        .every((r) => r.autoApproveVerdict === null),
    ).toBe(true);
  });

  it('records commit_failed with status and error when an eligible commit does not return 200', async () => {
    stageCodeGroup('g-fail');
    backend.updateStatus.mockRejectedValue(new Error('notion down'));
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    const rows = skipRows();
    expect(systemCommits()).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('commit_failed');
    expect(typeof rows[0].status).toBe('number');
    expect(typeof rows[0].error).toBe('string');
  });

  it('null once the group is committed', async () => {
    stageCodeGroup('g-done');
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    const api = await listApi();
    expect(
      api
        .filter((r) => r.groupId === 'g-done')
        .every((r) => r.autoApproveVerdict === null),
    ).toBe(true);
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
      const actual = await vi.importActual<
        typeof import('../../audit/AuditLog')
      >('../../audit/AuditLog');
      mockRecordEvent.mockImplementation(actual.recordEvent);
      db.prepare('DELETE FROM audit_log').run();
      stageTriageGroup('g-op-v', '🔧 Operational', verdict);
      await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
      expect(systemCommits()).toHaveLength(0);
      const skips = queryAuditLogByProject(PROJECT, {
        eventType: 'auto_approve_skipped',
      }).entries;
      expect(skips).toHaveLength(1);
      expect((skips[0].payload as { standard: string }).standard).toBe(
        'triage-clean',
      );
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

  it('auto-commits a triage group once its pickOne is answered', async () => {
    await useRealGate();
    setType('🔎 Investigation');
    stageTriageGroup('g-tans', '🔎 Investigation');
    db.prepare(
      `INSERT INTO staged_intent
         (id, kind, payload, payload_hash, project_id, session_id, state, created_at, updated_at)
       VALUES ('pick-ta', 'decision.pickOne', '{}', 'h', ?, ?, 'committed', 1, 1)`,
    ).run(PROJECT, SESSION);
    await autoCommitCodeReadyGroupsForSession(SESSION, undefined, undefined);
    expect(systemCommits()).toHaveLength(1);
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
