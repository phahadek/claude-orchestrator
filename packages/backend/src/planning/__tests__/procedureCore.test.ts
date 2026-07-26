import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CORE_PRINCIPLES,
  DESIGN_TERMINAL_ARTIFACTS_ORDERING,
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

  it('instructs staging each listed Open Question as a decision.pickOne with no competing "stage the concrete write when confident" routing', () => {
    const batchLockingText = renderPrinciple(
      CORE_PRINCIPLES.find((p) => p.id === 'design-no-question-bundling')!,
      'design',
    );
    expect(batchLockingText).toMatch(/decision\.pickOne/);
    expect(batchLockingText).toMatch(/never a `task\.updateBody` edit/);

    const genuineForksPrinciple = CORE_PRINCIPLES.find(
      (p) => p.id === 'decision-pickone-genuine-forks-only',
    )!;
    expect(genuineForksPrinciple.appliesTo).not.toContain('design');

    const designScopeText = renderPrinciple(
      CORE_PRINCIPLES.find(
        (p) => p.id === 'decision-pickone-genuine-forks-only-design-scope',
      )!,
      'design',
    );
    expect(designScopeText).toMatch(
      /NEVER applies to a 📐 Design task's listed Open Questions/,
    );
    expect(designScopeText).not.toMatch(
      /stage that proposal normally \(its concrete write/,
    );

    const rendered = renderHardRulesMarkdown();
    expect(rendered).not.toMatch(
      /listed Open Question[\s\S]{0,200}stage that proposal normally \(its concrete write/,
    );
  });

  it('instructs a per-candidate triage of the Manual verification section before accretion, naming the three outcomes', () => {
    const step = ORDERED_STEPS.find((s) => s.id === 'accrete-gate-and-seed')!;
    const text = stepSummaryFor(step, 'groom');
    expect(text).toMatch(/triage every candidate line/);
    expect(text).toContain('`runtime-observable`');
    expect(text).toContain('`config-or-code-determined`');
    expect(text).toContain('`needs-triage`');
  });

  it('states the deciding question in terms a groomer can apply', () => {
    const step = ORDERED_STEPS.find((s) => s.id === 'accrete-gate-and-seed')!;
    const text = stepSummaryFor(step, 'groom');
    expect(text).toMatch(
      /would a headless verifier be\s+able to cite a behavioural trace for this, or only cite\s+the code\? If only\s+the code, it is a test/,
    );
  });

  it('requires a config-or-code-determined candidate to be relocated to 🤖 Automated tests, not dropped', () => {
    const step = ORDERED_STEPS.find((s) => s.id === 'accrete-gate-and-seed')!;
    const text = stepSummaryFor(step, 'groom');
    expect(text).toMatch(
      /relocate the line to the task's\s+"### 🤖 Automated tests" section instead\s+of dropping it/,
    );
    expect(text).toMatch(
      /count of candidates in\s+must equal the count accreted plus the count relocated/,
    );
  });

  it('keeps the injected rule and the vendored standard stating the same triage criterion', () => {
    const step = ORDERED_STEPS.find((s) => s.id === 'accrete-gate-and-seed')!;
    const text = stepSummaryFor(step, 'groom');
    const taskWritingMd = readFileSync(
      join(repoRoot, 'config-template', 'task-writing.md'),
      'utf8',
    );
    const sharedPhrases = [
      'runtime-observable',
      'config-or-code-determined',
      'needs-triage',
      'behavioural trace',
    ];
    for (const phrase of sharedPhrases) {
      expect(
        text.includes(phrase),
        `procedureCore step should reference "${phrase}"`,
      ).toBe(true);
      expect(
        taskWritingMd.includes(phrase),
        `config-template/task-writing.md should reference "${phrase}"`,
      ).toBe(true);
    }
  });

  it('stages the Manual-verification strip as a task.patchBodySection remove, grouped with the Ready-flip, never a whole-body task.updateBody', () => {
    const step = ORDERED_STEPS.find((s) => s.id === 'accrete-gate-and-seed')!;
    const text = stepSummaryFor(step, 'groom');
    expect(text).toContain('`task.patchBodySection`');
    expect(text).toMatch(/operation:?\s*"remove"/);
    expect(text).toMatch(/👁️ Manual verification/);
    expect(text).toMatch(/same `?groupId`?/);
    expect(text).toMatch(/removed entirely/);
    expect(text).toContain('Covered by the Manual Verification Gate.');
    expect(text).toMatch(/no strip intent at all/);
    expect(text).toMatch(/whole body|whole-body/);
    expect(text).toContain('task.updateBody` as');
  });

  describe('design terminal-artifacts ordering', () => {
    /** Every rendered snippet from the assembled design procedure. */
    function assembledDesignProcedureText(): string {
      const principleText = principlesFor('design')
        .map((p) => renderPrinciple(p, 'design'))
        .join('\n');
      const stepText = stepsFor('design')
        .map((s) => stepSummaryFor(s, 'design'))
        .join('\n');
      return `${principleText}\n${stepText}`;
    }

    it('names arch.* writes and follow-on task.create alongside task.updateBody as artifacts staged only after every Open Question is answered', () => {
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toContain('task.updateBody');
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toContain('arch.createUnit');
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toContain('arch.updateUnit');
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toContain(
        'arch.supersedeUnit',
      );
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toContain('task.create');
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toMatch(
        /staged only once every listed Open Question is answered/,
      );
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toMatch(
        /completeness critic has run/,
      );

      const assembled = assembledDesignProcedureText();
      expect(assembled).toContain('arch.createUnit');
      expect(assembled).toContain(
        'staged only once every listed Open Question is answered',
      );
    });

    it('states the ordering requirement once and references it, not duplicating it across the three existing sites', () => {
      const noBundling = CORE_PRINCIPLES.find(
        (p) => p.id === 'design-no-question-bundling',
      )!;
      const presentForSignoff = ORDERED_STEPS.find(
        (s) => s.id === 'present-for-signoff',
      )!;
      const applyOnSignoff = ORDERED_STEPS.find(
        (s) => s.id === 'apply-on-signoff',
      )!;

      expect(noBundling.text).toContain(DESIGN_TERMINAL_ARTIFACTS_ORDERING);
      expect(stepSummaryFor(presentForSignoff, 'design')).toContain(
        DESIGN_TERMINAL_ARTIFACTS_ORDERING,
      );
      expect(stepSummaryFor(applyOnSignoff, 'design')).toContain(
        DESIGN_TERMINAL_ARTIFACTS_ORDERING,
      );

      // The distinctive ordering sentence is authored exactly once in source —
      // as the DESIGN_TERMINAL_ARTIFACTS_ORDERING constant — not hand-typed
      // separately at each site.
      const coreSource = readFileSync(
        join(__dirname, '..', 'procedureCore.ts'),
        'utf8',
      );
      const declarationCount = (
        coreSource.match(
          /export const DESIGN_TERMINAL_ARTIFACTS_ORDERING =/g,
        ) ?? []
      ).length;
      expect(declarationCount).toBe(1);
    });

    it('still requires the completeness critic to run before the Implementation notes', () => {
      const critic = CORE_PRINCIPLES.find(
        (p) => p.id === 'design-completeness-critic',
      )!;
      expect(critic.text).toMatch(
        /after every.*listed Open Question is locked and before staging the/,
      );
      expect(critic.text).toContain('task.updateBody');
    });

    it('still permits independent Open Questions to be staged in the same turn', () => {
      const noBundling = CORE_PRINCIPLES.find(
        (p) => p.id === 'design-no-question-bundling',
      )!;
      expect(noBundling.text).toMatch(
        /DO stage every Open\s+Question whose answer is independent of the others in the same turn/,
      );
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toMatch(
        /independent Open Questions still stage in\s+the same turn/,
      );
    });

    it('exempts a file-sibling split task.create from the ordering rule', () => {
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toMatch(/EXEMPT/);
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toMatch(
        /file-sibling.*task\.create/,
      );
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toMatch(/Split-don't-trim/);
      expect(DESIGN_TERMINAL_ARTIFACTS_ORDERING).toMatch(
        /may be staged\s+before Open Questions resolve/,
      );
    });

    it('leaves the groom and ops procedures unchanged by the ordering rule', () => {
      for (const skill of ['groom', 'ops'] as SkillId[]) {
        const principleText = principlesFor(skill)
          .map((p) => renderPrinciple(p, skill))
          .join('\n');
        const stepText = stepsFor(skill)
          .map((s) => stepSummaryFor(s, skill))
          .join('\n');
        expect(`${principleText}\n${stepText}`).not.toContain(
          DESIGN_TERMINAL_ARTIFACTS_ORDERING,
        );
      }
    });
  });
});
