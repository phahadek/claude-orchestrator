import { describe, it, expect } from 'vitest';
import {
  CORE_PRINCIPLES,
  ORDERED_STEPS,
  renderPrinciple,
  stepSummaryFor,
  principlesFor,
} from '../planning/procedureCore';
import {
  assemblePlanningProcedure,
  deriveDesignDigestSlice,
} from '../planning/procedureAssembler';
import type { DesignLoadResult } from '../design/designLoad';

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
      items: ['Should we do X or Y?', 'Should we do A or B?'],
      source: 'explicit_heading',
    },
    archSource: 'notion',
    archUnits: [{ id: 'arch-1', title: 'Arch Unit A', raw: '- Arch Unit A' }],
    unresolvedPageRefs: [],
    codeMapGrounding: {},
  };
}

function renderedDesignOutput(): string {
  return assemblePlanningProcedure({
    taskName: 'A task',
    taskUrl: 'https://notion.so/x',
    milestoneId: 'm1',
    projectId: 'p1',
    digest: {
      workflow: 'design',
      data: deriveDesignDigestSlice(fixtureDesignLoadResult()),
    },
  });
}

function renderedProcedureFor(skill: 'groom' | 'design' | 'ops'): string {
  const principles = principlesFor(skill)
    .map((p) => renderPrinciple(p, skill))
    .join('\n');
  const steps = ORDERED_STEPS.filter((s) => s.appliesTo.includes(skill))
    .map((s) => stepSummaryFor(s, skill))
    .join('\n');
  return `${principles}\n${steps}`;
}

describe('assembled design procedure — architecture and follow-on task deliverables', () => {
  it('names architecture-page updates as a required deliverable of a design pass', () => {
    const output = renderedDesignOutput();
    expect(output).toMatch(
      /architecture pages? and follow-on code tasks are required deliverables/i,
    );
    expect(output).toMatch(
      /stage the architecture-unit change\(s\) each locked decision implies/i,
    );

    const principle = CORE_PRINCIPLES.find(
      (p) => p.id === 'design-architecture-and-followon-required',
    );
    expect(principle).toBeDefined();
    expect(principle!.appliesTo).toEqual(['design']);
  });

  it('requires the implied follow-on Code tasks to be staged in the same pass, not only split-overflow tasks', () => {
    const output = renderedDesignOutput();
    expect(output).toMatch(
      /stage the implementation work a locked design implies as `task\.create` intents.*in this same pass/is,
    );
    expect(output).toMatch(
      /not limited to the 'Split-don't-trim' overflow case/i,
    );

    const followOnPrinciple = ORDERED_STEPS.find(
      (s) => s.id === 'file-follow-on-tasks',
    )!;
    const designText = stepSummaryFor(followOnPrinciple, 'design');
    expect(designText).toMatch(/far more often than it implies a split/i);
    expect(designText).toMatch(
      /not only in the '🔲 Backlog' split-overflow case/i,
    );
  });

  it('no longer describes the Implementation-notes task.updateBody as the session final step', () => {
    const output = renderedDesignOutput();
    expect(output).not.toMatch(/as the final step/i);

    for (const skill of ['design'] as const) {
      for (const principle of principlesFor(skill)) {
        expect(renderPrinciple(principle, skill)).not.toMatch(
          /as the final step/i,
        );
      }
      for (const step of ORDERED_STEPS.filter((s) =>
        s.appliesTo.includes(skill),
      )) {
        expect(stepSummaryFor(step, skill)).not.toMatch(/as the final step/i);
      }
    }
  });

  it('still states that the Implementation-notes write is staged exactly once, after the completeness critic', () => {
    const output = renderedDesignOutput();
    expect(output).toMatch(
      /task\.updateBody.*staged exactly once.*after every (o|O)pen (q|Q)uestion is locked and the completeness critic has run/is,
    );

    const questionBundling = CORE_PRINCIPLES.find(
      (p) => p.id === 'design-no-question-bundling',
    )!;
    expect(renderPrinciple(questionBundling, 'design')).toMatch(
      /staged exactly once, the last of the decision-recording steps, only after every question is settled and the completeness critic below has run/i,
    );
  });

  it('requires an explicit "no applicable change" statement when a design touches no architecture page or spawns no follow-on task', () => {
    const output = renderedDesignOutput();
    expect(output).toMatch(
      /none — these decisions change no architecture page/i,
    );
    expect(output).toMatch(
      /none — no implementation work beyond the locked decisions/i,
    );

    const principle = CORE_PRINCIPLES.find(
      (p) => p.id === 'design-architecture-and-followon-required',
    )!;
    const text = renderPrinciple(principle, 'design');
    expect(text).toMatch(
      /silence is never an acceptable substitute for that statement/i,
    );
  });

  it('introduces no numeric threshold or promotion block for either deliverable', () => {
    const principle = CORE_PRINCIPLES.find(
      (p) => p.id === 'design-architecture-and-followon-required',
    )!;
    const text = renderPrinciple(principle, 'design');
    expect(text).toMatch(/no minimum count/i);
    expect(text).toMatch(/neither is\s+wired into a promotion block/i);
    expect(text).not.toMatch(/at least \d+/i);
    expect(text).not.toMatch(/>~?\d+/);

    const output = renderedDesignOutput();
    expect(output).not.toMatch(
      /at least (one|two|three|\d+) (architecture unit|follow-on task)/i,
    );
  });

  it('does not change the groom or ops procedures', () => {
    const groomText = renderedProcedureFor('groom');
    const opsText = renderedProcedureFor('ops');
    expect(groomText).not.toMatch(
      /architecture pages? and follow-on code tasks are required deliverables/i,
    );
    expect(opsText).not.toMatch(
      /architecture pages? and follow-on code tasks are required deliverables/i,
    );

    const principle = CORE_PRINCIPLES.find(
      (p) => p.id === 'design-architecture-and-followon-required',
    )!;
    expect(principle.appliesTo).not.toContain('groom');
    expect(principle.appliesTo).not.toContain('ops');

    const followOnStep = ORDERED_STEPS.find(
      (s) => s.id === 'file-follow-on-tasks',
    )!;
    expect(followOnStep.summaryOverrides?.groom).toBeUndefined();
    expect(stepSummaryFor(followOnStep, 'groom')).not.toMatch(
      /far more often than it implies a split/i,
    );
    expect(stepSummaryFor(followOnStep, 'ops')).not.toMatch(
      /far more often than it implies a split/i,
    );
  });
});
