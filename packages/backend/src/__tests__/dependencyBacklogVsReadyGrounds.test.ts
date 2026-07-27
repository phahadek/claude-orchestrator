/**
 * Regression coverage for the fix distinguishing readiness (is the spec
 * settled) from dispatch (when the work runs) in the injected groom
 * procedure's Depends On guidance. Previously any non-Done dependency —
 * including a 💻 Code one — was blanket grounds to leave a task at
 * 🔲 Backlog, serialising the backlog behind the dependency graph the
 * dispatcher already orders for free. Only a non-Done 📐 Design / 📋
 * Planning dependency can still reshape the task's own scope and is genuine
 * grounds to hold at Backlog; any other non-Done dependency (most commonly
 * 💻 Code) does not block grooming — the task promotes to 🗂️ Ready on its
 * own merits and the Depends On edge queues it behind its blocker. See
 * procedureAssembler.ts:599-620 for the corrected wording.
 */
import { describe, it, expect } from 'vitest';
import {
  assemblePlanningProcedure,
  deriveGroomDigestSlice,
  type PlanningDigest,
} from '../planning/procedureAssembler';
import type { GroomLoadResult } from '../groom/groomLoad';

function fixtureGroomLoadResult(): GroomLoadResult {
  return {
    contextPages: [],
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
        readinessViolations: [],
        sizeCheckSeed: { files: 3, loc_method: 'estimated' },
        typeCheck: { decision: 'none' },
        regions: { packages: [], files: [], planned: [] },
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

function groomOutput(): string {
  const digest: PlanningDigest = {
    workflow: 'groom',
    data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
  };
  return assemblePlanningProcedure({
    taskName: 'A task',
    taskUrl: 'https://notion.so/x',
    milestoneId: 'm1',
    projectId: 'p1',
    digest,
  });
}

describe('groom procedure Depends On guidance — readiness vs dispatch', () => {
  it('states a non-Done 💻 Code (or other non-design) dependency does not prevent promotion to Ready', () => {
    const output = groomOutput();
    expect(output).toMatch(
      /non-Done dependency of any other type.*groom the task\s*normally and stage.*Ready/is,
    );
    expect(output).toMatch(/not a readiness defect/i);
  });

  it('states a non-Done 📐 Design or 📋 Planning dependency does hold the task at Backlog', () => {
    const output = groomOutput();
    expect(output).toMatch(
      /non-Done\s*📐 Design or 📋 Planning Depends On task IS\s*grounds for `Backlog`/i,
    );
    expect(output).toMatch(/can still reshape this task's own scope/i);
  });

  it('still keeps premise-needs-re-investigation and body-needs-rewriting as Backlog cases', () => {
    const output = groomOutput();
    expect(output).toMatch(/premise needs\s*re-investigation/i);
    expect(output).toMatch(/whose body needs rewriting/i);
  });

  it('still restricts Deferred to superseded / never-to-be-done scope', () => {
    const output = groomOutput();
    expect(output).toMatch(
      /scope is fully covered by another task, or.*should not be done at all/i,
    );
    expect(output).not.toMatch(/Deferred.*merely blocked on\s*a dependency/is);
  });

  it('instructs no task.setStatus when the outcome is no status change', () => {
    const output = groomOutput();
    expect(output).toMatch(
      /Never stage `task\.setStatus` to the status the task already holds/i,
    );
    expect(output).toMatch(
      /report the conclusion.*in chat.*end the turn instead of staging anything/is,
    );
  });
});
