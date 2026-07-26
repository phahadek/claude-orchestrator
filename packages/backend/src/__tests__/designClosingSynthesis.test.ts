import { describe, it, expect } from 'vitest';
import { CORE_PRINCIPLES, renderPrinciple } from '../planning/procedureCore';
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

describe('assembled design procedure — closing synthesis for approval', () => {
  it('instructs the terminal task.updateBody intent to carry the closing synthesis as its decisionProposal', () => {
    const output = renderedDesignOutput();
    expect(output).toMatch(
      /task\.updateBody.*carr(y|ies|ying).*(five-part )?closing synthesis.*`decisionProposal`/is,
    );
    expect(output).toMatch(/operator approves that synthesis/i);
  });

  it('names all five required synthesis sections', () => {
    const output = renderedDesignOutput();
    expect(output).toMatch(/\*\*Decision summary\*\*/);
    expect(output).toMatch(/\*\*Open questions resolved\*\*/);
    expect(output).toMatch(/\*\*Completeness-critic dispositions\*\*/);
    expect(output).toMatch(/\*\*Architecture pages updated\*\*/);
    expect(output).toMatch(/\*\*Follow-on Code tasks filed\*\*/);
  });

  it('instructs that completeness-critic gaps and dispositions be presented for approval, not only recorded', () => {
    const output = renderedDesignOutput();
    expect(output).toMatch(
      /every completeness-critic gap and its proposed disposition.*must appear in part 3 for\s+operator sign-off/is,
    );
    expect(output).toMatch(/recorded is not approved/i);

    const criticPrinciple = CORE_PRINCIPLES.find(
      (p) => p.id === 'design-completeness-critic',
    );
    expect(criticPrinciple).toBeDefined();
    const criticText = renderPrinciple(criticPrinciple!, 'design');
    expect(criticText).toMatch(/closing synthesis/i);
    expect(criticText).toMatch(/recording is not presenting/i);
  });

  it('still requires the completeness-disposition store call for every candidate, with a reason from the existing vocabulary', () => {
    const dispositionPrinciple = CORE_PRINCIPLES.find(
      (p) => p.id === 'design-disposition-dont-drop',
    );
    expect(dispositionPrinciple).toBeDefined();
    const text = renderPrinciple(dispositionPrinciple!, 'design');
    expect(text).toMatch(
      /POST `?\/api\/design\/:taskId\/completeness-disposition/,
    );
    expect(text).toMatch(
      /resolved.*out-of-scope.*not-a-decision.*fold.*file-sibling.*sibling-owned/s,
    );
    expect(text).toMatch(/DO NOT drop a candidate silently/i);
  });

  it('still requires the critic to run exactly once per Design task, including when every question locked cleanly', () => {
    const criticPrinciple = CORE_PRINCIPLES.find(
      (p) => p.id === 'design-completeness-critic',
    );
    const text = renderPrinciple(criticPrinciple!, 'design');
    expect(text).toMatch(/exactly once per Design task/i);
    expect(text).toMatch(
      /DO NOT skip the critic\s+pass because every listed question already locked cleanly/i,
    );
  });

  it('no longer frames the terminal step as validating a task-body write', () => {
    const output = renderedDesignOutput();
    expect(output).not.toMatch(/validat\w* the (task-)?body write/i);
    expect(output).not.toMatch(/summarizing the locked decisions/i);
    expect(output).toMatch(
      /never a separate diff to validate|never diffing the body write|not diffing the body write/i,
    );
  });
});
