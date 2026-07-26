/**
 * Regression coverage for the fix narrowing the injected groom procedure's
 * grounds for staging ⏭️ Deferred. Deferred means "scope superseded by
 * another task, or should never be done" — it is terminal (skipped by
 * future grooming, and blocks any dependent since only ✅ Done satisfies a
 * dependency). "Better revisited later" — blocked on a dependency, premise
 * needs re-investigation, body needs rewriting — is a 🔲 Backlog case: it
 * stays in the grooming queue. See procedureAssembler.ts and
 * procedureCore.ts for the corrected wording.
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

describe('groom procedure Deferred-vs-Backlog grounds', () => {
  it('does not offer "revisit later" (or equivalent) as grounds for Deferred', () => {
    const output = groomOutput();
    expect(output).not.toMatch(/revisit(ed)? later/i);
  });

  it('states Deferred is for superseded / not-to-be-done scope, and names blocked-on-dependency / needs-rewrite as Backlog cases', () => {
    const output = groomOutput();
    expect(output).toMatch(
      /scope is fully covered by another task, or.*should not be done at all/i,
    );
    expect(output).toMatch(/blocked on a dependency/i);
    expect(output).toMatch(
      /premise that needs re-investigation|needs re-investigation/i,
    );
    expect(output).toMatch(/needs rewriting/i);
    expect(output).toContain('Backlog');
  });

  it('states both Deferred consequences: skipped by future grooming, and blocks dependents', () => {
    const output = groomOutput();
    expect(output).toMatch(/future grooming passes skip/i);
    expect(output).toMatch(
      /blocks that task forever|only Done\s*satisfies a dependency/i,
    );
  });

  it('presents Deferred as a first-class outcome, not a fallback', () => {
    const output = groomOutput();
    expect(output).toMatch(
      /first-class alternative outcome, not a fallback for a session that got stuck/i,
    );
  });
});

describe('procedureCore contradiction rule no longer presents Backlog and Deferred as interchangeable', () => {
  it('directs a digest/spot-check contradiction to Backlog, not an "or Deferred" choice', () => {
    const output = groomOutput();
    expect(output).toMatch(
      /keep the task at\s*Backlog with a decisionProposal/i,
    );
    expect(output).not.toMatch(/Backlog, or stage it Deferred/i);
  });
});
