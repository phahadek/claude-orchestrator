/**
 * Code auto-approve: a fully eligible Code Ready-flip group commits as the
 * system when both the global and per-project switch are on; every other
 * case leaves the group staged.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const {
  mockGetTaskBackend,
  mockRecordEvent,
  mockClassifyReadyProposal,
  mockHasPickOne,
  projectState,
} = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockRecordEvent: vi.fn(),
  mockClassifyReadyProposal: vi.fn(),
  mockHasPickOne: vi.fn(),
  projectState: { enabled: true },
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
  return {
    ...actual,
    getTaskCache: vi.fn().mockReturnValue(null),
    hasDecisionPickOneForSession: mockHasPickOne,
  };
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
    getProjectById: (id: string) =>
      id.startsWith('proj-ca')
        ? {
            id,
            name: id,
            projectDir: '/nonexistent-code-auto-approve',
            contextUrl: '',
            boardId: '',
            taskSource: 'notion',
            gitMode: 'github',
            autoLaunchEnabled: false,
            autoLaunchMilestoneId: null,
            autoMergeEnabled: false,
            codeAutoApproveEnabled: projectState.enabled,
            milestoneBranching: null,
            nonMilestoneSourceConfig: null,
            dataResidencyConfirmed: false,
            baseBranch: 'dev',
          }
        : undefined,
  };
});

import { db } from '../../db/db';
import {
  getStagedIntent,
  insertSession,
  upsertTaskCache,
} from '../../db/queries';
import { runtimeSettings } from '../../config';
import {
  stageIntent,
  commitGroupIntents,
  autoCommitCodeReadyGroup,
} from '../stagedIntents';

const BODY = [
  '## Summary',
  'Tweak a label.',
  '## Files / paths affected',
  '- `packages/frontend/src/components/Label.tsx`',
].join('\n');

const GATE = {
  type: '💻 Code',
  size_check: { decision: 'no_split', loc: 100, files: 2 },
  type_check: { decision: 'none' },
  seam_check: { decision: 'single_seam', seams: [{ kind: 'ui', what: 'x' }] },
};

let n = 0;

function seedSession(sessionId: string, taskId: string) {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: null,
    project_context_url: null,
    status: 'done',
    started_at: 0,
    session_type: 'groom',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    granted_capabilities: '[]',
  });
}

function stageEligible(
  opts: {
    gate?: Record<string, unknown>;
    dependsOn?: string[];
    extraMemberTask?: string;
  } = {},
) {
  n += 1;
  const taskId = `t-ca-${n}`;
  const groupId = `g-ca-${n}`;
  const sessionId = `s-ca-${n}`;
  const projectId = `proj-ca-${n}`;
  seedSession(sessionId, taskId);
  const dependsOn = stageIntent(
    'task.setDependsOn',
    { taskId, dependsOn: opts.dependsOn ?? ['dep-1'] },
    projectId,
    groupId,
    sessionId,
  );
  const setStatus = stageIntent(
    'task.setStatus',
    { taskId, status: 'Ready', groomingGate: { ...GATE, ...opts.gate } },
    projectId,
    groupId,
    sessionId,
  );
  return { taskId, groupId, sessionId, projectId, dependsOn, setStatus };
}

const updateStatus = vi.fn();
const fetchTaskPage = vi.fn();

function groupCommittedEvents() {
  return mockRecordEvent.mock.calls
    .map((c) => c[0])
    .filter((e) => e.event_type === 'staged_intent_group_committed');
}

beforeEach(() => {
  mockRecordEvent.mockReset();
  mockClassifyReadyProposal.mockReset();
  mockClassifyReadyProposal.mockResolvedValue(undefined);
  mockHasPickOne.mockReset();
  mockHasPickOne.mockReturnValue(false);
  updateStatus.mockReset();
  updateStatus.mockResolvedValue(undefined);
  fetchTaskPage.mockReset();
  fetchTaskPage.mockResolvedValue(BODY);
  mockGetTaskBackend.mockReturnValue({
    type: 'notion',
    fetchTaskPage,
    updateStatus,
    setDependsOn: vi.fn().mockResolvedValue(undefined),
  });
  projectState.enabled = true;
  runtimeSettings.code_auto_approve_enabled = true;
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare("DELETE FROM task_cache WHERE task_id LIKE 'board:%'").run();
  upsertTaskCache(
    'board:ca',
    JSON.stringify([{ id: 'dep-1', status: 'Done', dependsOn: [] }]),
  );
});

afterAll(() => {
  runtimeSettings.code_auto_approve_enabled = false;
});

async function run(groupId: string) {
  return autoCommitCodeReadyGroup(groupId, undefined, undefined);
}

function seedCurrentDependsOn(taskId: string, dependsOn: string[]) {
  upsertTaskCache(
    'board:ca',
    JSON.stringify([
      { id: 'dep-1', status: 'Done', dependsOn: [] },
      { id: taskId, status: 'Backlog', dependsOn },
    ]),
  );
}

describe('autoCommitCodeReadyGroup', () => {
  it('commits a fully eligible Code group as the system with evidence', async () => {
    const { groupId, taskId, setStatus } = stageEligible();
    seedCurrentDependsOn(taskId, ['dep-1']);

    expect(await run(groupId)).toBe(true);

    expect(getStagedIntent(setStatus.id)?.state).toBe('committed');
    const events = groupCommittedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].actor_type).toBe('system');
    expect(events[0].payload.provenance).toBe('auto');
    expect(events[0].payload.evidence.standard).toBe('code-auto-approve');
  });

  it('leaves the group staged when the global switch is off', async () => {
    const { groupId, taskId, setStatus } = stageEligible();
    seedCurrentDependsOn(taskId, ['dep-1']);
    runtimeSettings.code_auto_approve_enabled = false;

    expect(await run(groupId)).toBe(false);
    expect(getStagedIntent(setStatus.id)?.state).toBe('staged');
    expect(groupCommittedEvents()).toHaveLength(0);
  });

  it('leaves the group staged when the project switch is off', async () => {
    const { groupId, taskId, setStatus } = stageEligible();
    seedCurrentDependsOn(taskId, ['dep-1']);
    projectState.enabled = false;

    expect(await run(groupId)).toBe(false);
    expect(getStagedIntent(setStatus.id)?.state).toBe('staged');
  });

  it('never evaluates a non-Code Ready flip', async () => {
    const { groupId, taskId, setStatus } = stageEligible({
      gate: { type: '🔧 Tooling' },
    });
    seedCurrentDependsOn(taskId, ['dep-1']);

    expect(await run(groupId)).toBe(false);
    expect(fetchTaskPage).not.toHaveBeenCalled();
    expect(getStagedIntent(setStatus.id)?.state).toBe('staged');
  });

  it('leaves the group staged when the session staged a decision.pickOne', async () => {
    const { groupId, taskId, setStatus } = stageEligible();
    seedCurrentDependsOn(taskId, ['dep-1']);
    mockHasPickOne.mockReturnValue(true);

    expect(await run(groupId)).toBe(false);
    expect(getStagedIntent(setStatus.id)?.state).toBe('staged');
  });

  it('leaves the group staged when size_check is over the cap', async () => {
    const { groupId, taskId, setStatus } = stageEligible({
      gate: { size_check: { decision: 'no_split', loc: 500, files: 2 } },
    });
    seedCurrentDependsOn(taskId, ['dep-1']);

    expect(await run(groupId)).toBe(false);
    expect(getStagedIntent(setStatus.id)?.state).toBe('staged');
  });

  it('leaves the group staged when a Depends On edge would be removed', async () => {
    const { groupId, taskId, setStatus } = stageEligible({
      dependsOn: ['other'],
    });
    seedCurrentDependsOn(taskId, ['dep-1']);

    expect(await run(groupId)).toBe(false);
    expect(getStagedIntent(setStatus.id)?.state).toBe('staged');
  });

  it('leaves the group staged when the current Depends On is unknown', async () => {
    const { groupId, setStatus } = stageEligible();

    expect(await run(groupId)).toBe(false);
    expect(getStagedIntent(setStatus.id)?.state).toBe('staged');
  });

  it('leaves the group staged when the tripwire matches', async () => {
    const { groupId, taskId, setStatus } = stageEligible();
    seedCurrentDependsOn(taskId, ['dep-1']);
    fetchTaskPage.mockResolvedValue(`${BODY}\nAdds a retry with backoff.`);

    expect(await run(groupId)).toBe(false);
    expect(getStagedIntent(setStatus.id)?.state).toBe('staged');
  });

  it('produces exactly one commit when an operator commit races the auto-commit', async () => {
    const { groupId, taskId } = stageEligible();
    seedCurrentDependsOn(taskId, ['dep-1']);

    const [auto, operator] = await Promise.all([
      run(groupId),
      commitGroupIntents(groupId, {
        override: false,
        reason: '',
        actorType: 'human',
        autoApprove: true,
      }),
    ]);

    expect(groupCommittedEvents()).toHaveLength(1);
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect([auto, operator.status === 200].filter(Boolean)).toHaveLength(1);
  });

  it('refuses an operator commit while the auto-commit is mid-apply', async () => {
    const { groupId, taskId } = stageEligible();
    seedCurrentDependsOn(taskId, ['dep-1']);
    let release: () => void = () => {};
    updateStatus.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const auto = run(groupId);
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalled());
    const operator = await commitGroupIntents(groupId, {
      override: false,
      reason: '',
      actorType: 'human',
      autoApprove: true,
    });
    expect(operator.status).toBe(409);
    release();
    expect(await auto).toBe(true);
    expect(groupCommittedEvents()).toHaveLength(1);
  });
});
