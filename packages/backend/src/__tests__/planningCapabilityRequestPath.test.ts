/**
 * A dispatched groom/design session that hits a sandbox or tool-scope wall
 * previously had no in-band escalation — session.requestCapability was
 * scoped to ops alone. This covers the fix: groom/design can now ask, the
 * ask renders without the ops-only journal-abstention wording (groom/design
 * have no journal to abstain into), the grant denylist still refuses the
 * same dangerous widenings regardless of who asks, and the newly-grantable
 * kind never becomes part of what the Ready-promotion gate requires.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/queries')>();
  return {
    ...actual,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

import {
  CORE_PRINCIPLES,
  renderPrinciple,
  principlesFor,
} from '../planning/procedureCore';
import { orchestratorMcpToolName } from '../mcp/toolNaming';
import {
  getSessionAllowedTools,
  isGrantable,
} from '../session/orchestrator-config';
import {
  assemblePlanningProcedure,
  deriveGroomDigestSlice,
  deriveDesignDigestSlice,
} from '../planning/procedureAssembler';
import type { GroomLoadResult } from '../groom/groomLoad';
import type { DesignLoadResult } from '../design/designLoad';
import { db } from '../db/db';
import { stageIntent, runStageTimeReadyChecks } from '../routes/stagedIntents';

// ─── fixtures (mirrors procedureAssembler.test.ts's minimal shape) ─────────

function fixtureGroomLoadResult(): GroomLoadResult {
  return {
    contextPages: [{ id: 'ctx-1', title: 'Master Context', markdown: '...' }],
    board: [],
    neighbourBoards: [],
    targetTasks: [
      {
        id: 'task-1',
        title: 'Do the thing',
        status: '🔲 Backlog',
        type: '💻 Code',
        priority: 'P1',
        url: 'https://notion.so/task-1',
        filesSection: '',
        rawMarkdown: '## Summary\n\nDo the thing body.',
        readinessViolations: [{ code: 'no_open_questions', message: 'ok' }],
        sizeCheckSeed: { files: 3, loc_method: 'estimated' },
        typeCheck: { decision: 'none' },
        regions: {
          packages: ['packages/backend'],
          files: ['packages/backend/src/foo.ts'],
          planned: [],
        },
        bindingConstraints: [],
        filesPathsEntries: [],
        dependsOnTasks: [],
      },
    ],
    codeWorklist: new Map(),
    gitFreshness: {},
    dependencyCandidates: [],
  } as unknown as GroomLoadResult;
}

function fixtureDesignLoadResult(): DesignLoadResult {
  return {
    task: {
      id: 'task-2',
      title: 'Design the thing',
      status: '🔄 In Progress',
      type: '🎨 Design',
      url: 'https://notion.so/task-2',
    },
    markdown: '# Design the thing\n\nSome body.',
    openQuestions: {
      items: ['Should we do X or Y?'],
      source: 'explicit_heading',
    },
    archSource: 'notion',
    archUnits: [],
    unresolvedPageRefs: [],
    codeMapGrounding: {},
  };
}

describe('groom/design capability-request rendering', () => {
  const principle = CORE_PRINCIPLES.find(
    (p) => p.id === 'ask-permission-not-speculative',
  )!;

  it('applies to groom and design in addition to ops', () => {
    expect(principle.appliesTo).toContain('groom');
    expect(principle.appliesTo).toContain('design');
    expect(principle.appliesTo).toContain('ops');
  });

  it.each(['groom', 'design'] as const)(
    'renders a concrete session.requestCapability invocation example for %s',
    (skill) => {
      const rendered = renderPrinciple(principle, skill);
      expect(rendered).toContain('session.requestCapability');
      expect(rendered).toContain(
        orchestratorMcpToolName('session.requestCapability'),
      );
      expect(rendered).toContain(
        '{"payload":{"capability":"<capability>","plan":"<plan>","evidence":"<evidence>"}}',
      );
    },
  );

  it.each(['groom', 'design'] as const)(
    'never carries the ops-only needs-setup journal-abstention wording for %s',
    (skill) => {
      const rendered = renderPrinciple(principle, skill);
      expect(rendered).not.toContain('needs-setup');
      expect(rendered).not.toMatch(/abstain straight to/);
    },
  );

  it('the ops rendering still carries the needs-setup journal-abstention wording', () => {
    const rendered = renderPrinciple(principle, 'ops');
    expect(rendered).toContain('needs-setup');
  });

  it.each(['groom', 'design'] as const)(
    'includes the rule in the assembled principle set for %s',
    (skill) => {
      const rendered = principlesFor(skill).find(
        (p) => p.id === 'ask-permission-not-speculative',
      );
      expect(rendered).toBeDefined();
    },
  );

  it('an assembled groom procedure renders the rule with a concrete invocation example', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });
    expect(output).toContain('Ask for what you need — never fabricate');
    expect(output).toContain(
      orchestratorMcpToolName('session.requestCapability'),
    );
    expect(output).not.toContain('needs-setup');
  });

  it('an assembled design procedure renders the rule with a concrete invocation example', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'design',
        data: deriveDesignDigestSlice(fixtureDesignLoadResult()),
      },
    });
    expect(output).toContain('Ask for what you need — never fabricate');
    expect(output).toContain(
      orchestratorMcpToolName('session.requestCapability'),
    );
    expect(output).not.toContain('needs-setup');
  });
});

describe('capability grant denylist stays skill-agnostic', () => {
  const denylisted = [
    'Write',
    'Edit',
    'NotebookEdit',
    'MultiEdit',
    'mcp__orchestrator__task_setStatus_apply',
    'apply:task-intent',
    'resolve:ops-journal',
    'mark-done',
  ];

  it.each(denylisted)(
    'isGrantable refuses "%s" regardless of requester',
    (capability) => {
      expect(isGrantable(capability)).toBe(false);
    },
  );

  it.each(denylisted)(
    'a groom session never gets "%s" merged into its allowlist even if granted',
    (capability) => {
      const merged = getSessionAllowedTools('groom', { allowed_tools: [] }, [
        capability,
      ]);
      expect(merged).not.toContain(capability);
    },
  );

  it('a groom session does get a grantable Bash capability merged in', () => {
    const merged = getSessionAllowedTools('groom', { allowed_tools: [] }, [
      'Bash(psql:*)',
    ]);
    expect(merged).toContain('Bash(psql:*)');
  });
});

describe('session.requestCapability is not counted toward the Ready-path required intent set', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM staged_intent').run();
    db.prepare('DELETE FROM staged_intent_group').run();
  });

  it('a session.requestCapability intent cannot be staged into a group at all, so it can never masquerade as the gate/seed accretion required for a Ready flip', async () => {
    const groupId = 'group-capability-request-1';
    expect(() =>
      stageIntent(
        'session.requestCapability',
        {
          capability: 'Bash(pip install:*)',
          plan: 'install the missing dependency',
          evidence: 'the sandbox denied Bash(pip install:*)',
        },
        'proj-1',
        groupId,
        'session-groom-1',
        null,
      ),
    ).toThrow(/cannot belong to a group/);

    const readyIntent = stageIntent(
      'task.setStatus',
      {
        taskId: 'task-capability-1',
        status: 'Ready',
        groomingGate: { type: '💻 Code' },
      },
      'proj-1',
      groupId,
      'session-groom-1',
      null,
    );

    // A grouped Ready-flip defers gate_contribution/seed_contribution
    // enforcement to the commit-time precheck (precheckGroupCommit) rather
    // than checking it at stage time (runStageTimeReadyChecks explicitly
    // passes skipGateContributionCheck/skipSeedContributionCheck for any
    // grouped intent — see its comment). So the only way a
    // session.requestCapability intent could ever masquerade as a genuine
    // gate.accrete/seed.stage contribution is by joining the same group —
    // which is refused outright above. What stage time still enforces here
    // is the baseline promotion gate (size/type checks, files/paths), which
    // this incomplete groomingGate payload fails regardless.
    const checked = await runStageTimeReadyChecks(readyIntent);
    expect(checked.annotation?.blocked).toBe(true);
    const reasons =
      checked.annotation && 'reasons' in checked.annotation
        ? checked.annotation.reasons
        : [];
    expect(reasons.length).toBeGreaterThan(0);
  });
});

describe('session.requestCapability is rejected at stage time when the capability is not a supported shape', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM staged_intent').run();
  });

  it('throws before staging a non-tool-shaped, non-session-record capability', () => {
    expect(() =>
      stageIntent(
        'session.requestCapability',
        {
          capability: 'banana',
          plan: 'do something',
          evidence: 'because',
        },
        'proj-1',
        null,
        'session-groom-2',
        null,
      ),
    ).toThrow(/not a supported capability shape/);
  });

  it.each([
    'Bash(psql:*)',
    'mcp__github__merge_pull_request',
    'read:session-record:target-session-9',
  ])('still stages a well-formed capability "%s" normally', (capability) => {
    const intent = stageIntent(
      'session.requestCapability',
      {
        capability,
        plan: 'do something',
        evidence: 'because',
      },
      'proj-1',
      null,
      'session-groom-3',
      null,
    );
    expect(intent.state).toBe('staged');
  });
});
