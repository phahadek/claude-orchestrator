import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CORE_PRINCIPLES,
  ORDERED_STEPS,
  READINESS_BAR,
  SIZE_TYPE_CHECK,
  SKILL_LABELS,
  renderHardRulesMarkdown,
  renderPrinciple,
  principlesFor,
  stepsFor,
  stepSummaryFor,
  type SkillId,
} from '../procedureCore';

const repoRoot = join(__dirname, '..', '..', '..', '..', '..');
const sharedHardRulesPath = join(
  repoRoot,
  'skills',
  '_shared',
  'reference',
  'hard-rules.md',
);

/**
 * Skills with an interactive SKILL.md a human types `/groom`/`/design`/`/ops`
 * to run. 'split' has no interactive counterpart — it is only ever a
 * dispatched session (launched by groomFlip.ts on a confirmed split_now
 * nomination), so it carries no SKILL.md to link/de-duplicate against.
 */
const INTERACTIVE_SKILLS: SkillId[] = ['groom', 'design', 'ops'];

const SKILL_MD_PATHS: Partial<Record<SkillId, string>> = {
  groom: join(repoRoot, 'skills', 'groom', 'SKILL.md'),
  design: join(repoRoot, 'skills', 'design', 'SKILL.md'),
  ops: join(repoRoot, 'skills', 'ops', 'SKILL.md'),
};

function readSkillMd(skill: SkillId): string {
  const path = SKILL_MD_PATHS[skill];
  if (!path) throw new Error(`no interactive SKILL.md for skill "${skill}"`);
  return readFileSync(path, 'utf8');
}

describe('procedureCore', () => {
  it('has at least one principle and one ordered step applicable to every skill', () => {
    const skills: SkillId[] = ['groom', 'design', 'ops', 'split'];
    for (const skill of skills) {
      expect(principlesFor(skill).length).toBeGreaterThan(0);
      expect(stepsFor(skill).length).toBeGreaterThan(0);
    }
  });

  it('the vendored shared reference file is byte-for-byte the module render', () => {
    const onDisk = readFileSync(sharedHardRulesPath, 'utf8');
    expect(onDisk).toBe(renderHardRulesMarkdown());
  });

  it('every interactive SKILL.md that carries a principle links to the shared core file', () => {
    for (const principle of CORE_PRINCIPLES) {
      for (const skill of principle.appliesTo) {
        if (!INTERACTIVE_SKILLS.includes(skill)) continue;
        const md = readSkillMd(skill);
        expect(
          md.includes('_shared/reference/hard-rules.md'),
          `${skill}/SKILL.md should link to the shared hard-rules core for principle "${principle.id}"`,
        ).toBe(true);
      }
    }
  });

  it('does not duplicate the shared principle prose inside the interactive SKILL.md files', () => {
    // The full canonical sentence for each cross-cutting principle should live
    // exactly once — inside the shared reference file — never re-typed verbatim
    // into a SKILL.md, which is what this module exists to prevent drifting on.
    const distinctiveSentences = [
      'directory-change-before-git as a hook-execution risk',
      'that is what causes the constant permission friction, not a workaround for it',
    ];
    for (const skill of Object.keys(SKILL_MD_PATHS) as SkillId[]) {
      const md = readSkillMd(skill);
      for (const sentence of distinctiveSentences) {
        expect(
          md.includes(sentence),
          `${skill}/SKILL.md should not restate the shared-core sentence "${sentence}" — it should link to the shared reference file instead`,
        ).toBe(false);
      }
    }
  });

  it('renders every principle for a skill with the placeholder resolved', () => {
    for (const principle of CORE_PRINCIPLES) {
      for (const skill of principle.appliesTo) {
        const rendered = principlesFor(skill).find(
          (p) => p.id === principle.id,
        );
        expect(rendered).toBeDefined();
      }
    }
    expect(renderHardRulesMarkdown()).not.toContain('{skillLabel}');
  });

  it('keeps ordered steps sequential and non-empty per applicable skill', () => {
    expect(ORDERED_STEPS.length).toBeGreaterThan(0);
    for (const step of ORDERED_STEPS) {
      expect(step.summary.length).toBeGreaterThan(0);
    }
  });

  it('renderPrinciple resolves the {skillLabel} placeholder per skill', () => {
    const humanIsGate = CORE_PRINCIPLES.find((p) => p.id === 'human-is-gate')!;
    for (const skill of humanIsGate.appliesTo) {
      const rendered = renderPrinciple(humanIsGate, skill);
      expect(rendered).toContain(SKILL_LABELS[skill]);
      expect(rendered).not.toContain('{skillLabel}');
    }
  });

  it('the deterministic-load step tells an injected session its context is already injected, with no loader to run', () => {
    const step = ORDERED_STEPS.find((s) => s.id === 'deterministic-load')!;
    expect(step.summary).toContain('already injected');
    expect(step.summary).not.toMatch(/sanctioned loader/i);
    expect(step.summary).toMatch(/no device-authed client/i);
    expect(step.summary).toMatch(/blocked state/i);
  });

  it('exposes the readiness bar and size/type check pointers to their real implementations', () => {
    expect(READINESS_BAR.implementedBy).toBe(
      'packages/backend/src/tasks/readinessGate.ts',
    );
    expect(SIZE_TYPE_CHECK.locSplitThreshold).toBe(500);
    expect(SIZE_TYPE_CHECK.implementedBy.length).toBeGreaterThan(0);
  });

  it('states the staging-as-terminal mandate as an explicit imperative DO/DO NOT directive for groom, design, and ops', () => {
    const step = ORDERED_STEPS.find((s) => s.id === 'present-for-signoff')!;
    const skills: SkillId[] = ['groom', 'design', 'ops'];
    for (const skill of skills) {
      const text = stepSummaryFor(step, skill);
      expect(text, `${skill} present-for-signoff summary`).toMatch(
        /^\*\*Directive/m,
      );
      expect(text, `${skill} present-for-signoff summary`).toMatch(
        /- DO stage/,
      );
      expect(text, `${skill} present-for-signoff summary`).toMatch(/- DO NOT/);
    }
  });

  it('states the ops capability-request path as a concrete imperative directive, not just the grant model', () => {
    const principle = CORE_PRINCIPLES.find(
      (p) => p.id === 'ask-permission-not-speculative',
    )!;
    const rendered = renderPrinciple(principle, 'ops');
    expect(rendered).toMatch(/^DO stage/);
    expect(rendered).toContain('mcp__orchestrator__session_requestCapability');
    expect(rendered).toMatch(/DO NOT abstain/);
    expect(rendered).toMatch(/DO NOT fabricate/);
  });

  it('states that a dispatched groom session only stages on apply-on-signoff, never applies', () => {
    const step = ORDERED_STEPS.find((s) => s.id === 'apply-on-signoff')!;
    const text = stepSummaryFor(step, 'groom');
    expect(text).toMatch(/never applies a write itself/);
    expect(text).not.toMatch(/stage and apply/i);
  });

  it('requires task.setDependsOn unconditionally in the groom present-for-signoff Ready path', () => {
    const step = ORDERED_STEPS.find((s) => s.id === 'present-for-signoff')!;
    const text = stepSummaryFor(step, 'groom');
    expect(text).toContain('task.setDependsOn` (always');
    expect(text).not.toContain(
      'task.setDependsOn` (when dependencies were found)',
    );
  });

  it('instructs surfacing a digest-contradicting spot-check as a blocker, not resolving around it', () => {
    const step = ORDERED_STEPS.find((s) => s.id === 'investigate')!;
    const text = stepSummaryFor(step, 'groom');
    expect(text).toMatch(/contradicts the digest/);
    expect(text).toMatch(/blocker to surface/);
    expect(text).toMatch(/never to wave away/);
  });

  it('anchors the injected-instruction style standard and references it from procedureCore', () => {
    const styleDocPath = join(
      repoRoot,
      'packages',
      'backend',
      'src',
      'planning',
      'INJECTED_PROCEDURE_STYLE.md',
    );
    const styleDoc = readFileSync(styleDocPath, 'utf8');
    expect(styleDoc).toMatch(/DO\b[\s\S]+DO NOT/);
    expect(styleDoc).toMatch(/IS \/ IS[- ]NOT/i);

    const coreSource = readFileSync(
      join(__dirname, '..', 'procedureCore.ts'),
      'utf8',
    );
    expect(coreSource).toContain('INJECTED_PROCEDURE_STYLE.md');
  });
});
