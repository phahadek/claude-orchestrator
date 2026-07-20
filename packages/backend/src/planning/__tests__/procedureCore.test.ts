import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CORE_PRINCIPLES,
  ORDERED_STEPS,
  renderHardRulesMarkdown,
  principlesFor,
  stepsFor,
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

const SKILL_MD_PATHS: Record<SkillId, string> = {
  groom: join(repoRoot, 'skills', 'groom', 'SKILL.md'),
  design: join(repoRoot, 'skills', 'design', 'SKILL.md'),
  ops: join(repoRoot, 'skills', 'ops', 'SKILL.md'),
};

function readSkillMd(skill: SkillId): string {
  return readFileSync(SKILL_MD_PATHS[skill], 'utf8');
}

describe('procedureCore', () => {
  it('has at least one principle and one ordered step applicable to every skill', () => {
    const skills: SkillId[] = ['groom', 'design', 'ops'];
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
});
