import { describe, it, expect } from 'vitest';
import {
  CORE_PRINCIPLES,
  principlesFor,
  renderPrinciple,
} from '../procedureCore';
import {
  assemblePlanningProcedure,
  deriveDesignDigestSlice,
} from '../procedureAssembler';
import type { DesignLoadResult } from '../../design/designLoad';

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

describe('design decision.pickOne payload-shape contract', () => {
  const principle = CORE_PRINCIPLES.find(
    (p) => p.id === 'design-decision-pickone-payload-shape',
  );

  it('is defined and scoped to design only', () => {
    expect(principle).toBeDefined();
    expect(principle!.appliesTo).toEqual(['design']);
    expect(principlesFor('design')).toContain(principle);
    expect(principlesFor('groom')).not.toContain(principle);
    expect(principlesFor('ops')).not.toContain(principle);
  });

  it('instructs one options[] entry per candidate solution, including recommended-against candidates', () => {
    const text = renderPrinciple(principle!, 'design');
    expect(text).toMatch(/one `options\[\]` entry per candidate solution/i);
    expect(text).toMatch(/recommends against/i);
    expect(text).toMatch(/DO NOT omit a rejected candidate/i);
  });

  it('instructs each option description to be self-contained, never carrying another option’s rationale', () => {
    const text = renderPrinciple(principle!, 'design');
    expect(text).toMatch(/self-contained/i);
    expect(text).toMatch(/DO NOT let it carry another option.s rationale/i);
    expect(text).toMatch(
      /DO NOT concatenate every candidate.s analysis into a single option/i,
    );
  });

  it('instructs the preferred solution to be named in decisionProposal', () => {
    const text = renderPrinciple(principle!, 'design');
    expect(text).toMatch(
      /DO name the preferred solution and its load-bearing reason explicitly in `decisionProposal`/i,
    );
  });

  it('keeps option descriptions architecture-level, relocating evidence to the investigation summary', () => {
    const text = renderPrinciple(principle!, 'design');
    expect(text).toMatch(/architecture-level statement/i);
    expect(text).toMatch(
      /file:line citations, arch-page section names, API-result specifics/i,
    );
    expect(text).toMatch(/investigation summary/i);
  });

  it('still states a single option is a valid confident recommendation', () => {
    const text = renderPrinciple(principle!, 'design');
    expect(text).toMatch(
      /A single `options` entry stays valid.*confident recommendation/i,
    );

    // The pre-existing batch-locking principle also carries this — keep both
    // in sync rather than dropping the guarantee when one is edited.
    const batchLocking = CORE_PRINCIPLES.find(
      (p) => p.id === 'design-no-batch-locking',
    );
    expect(renderPrinciple(batchLocking!, 'design')).toMatch(
      /a single option is a confident recommendation/i,
    );
  });

  it('is rendered into the assembled design procedure output', () => {
    const output = renderedDesignOutput();
    expect(output).toMatch(/decision\.pickOne payload shape/i);
    expect(output).toContain('presentation.md');
    expect(output).toMatch(/one `options\[\]` entry per candidate solution/i);
  });

  it('renders a worked decision.pickOne example naming a rejected candidate as its own option', () => {
    const output = renderedDesignOutput();
    expect(output).toContain('Per-worker queue');
    expect(output).toContain('Shared queue');
    expect(output).toMatch(/rejected 'Shared queue' candidate gets its own option/);
  });
});
