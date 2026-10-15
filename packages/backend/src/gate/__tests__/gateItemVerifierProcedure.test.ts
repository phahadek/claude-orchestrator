/**
 * The injected gate-verify procedure told a "bounded one-shot" session it
 * could skip staging session.requestCapability and report needs-setup
 * instead — an escape clause that read as the default path for exactly the
 * session type it was injected into (see buildGateVerifyProcedure's own
 * docstring: "a bounded best-effort single-item" run). Sessions took it,
 * spending their gate.verify verdict while a grant was seconds away. This
 * asserts the clause is gone while the rest of that paragraph — stage the
 * request and end the turn, never fabricate a pass/fail around a permission
 * denial — still stands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockGetProjectById = vi.fn();
vi.mock('../../config', () => ({
  getProjectById: (...args: unknown[]) => mockGetProjectById(...args),
}));

import { buildGateVerifyProcedure } from '../gateItemVerifier';
import { renderAdHocReadCapability } from '../../planning/procedureAssembler';
import type { GateItem } from '../gateStore';

function makeItem(overrides: Partial<GateItem> = {}): GateItem {
  return {
    id: 'item-1',
    project: 'proj-a',
    milestone: 'M12',
    text: 'the described behavior works as intended',
    classification: 'Read-Only',
    state: 'runnable',
    updatedAt: new Date(0).toISOString(),
    sources: [],
    events: [],
    ...overrides,
  };
}

describe('buildGateVerifyProcedure', () => {
  let projectDir: string;

  // A real tmp project dir with no `.claude-orchestrator.yml` (or, per-test,
  // one written with a declared `ad_hoc_read_command`) so
  // `renderAdHocReadCapability`'s project resolution runs for real rather
  // than mocking `loadOrchestratorConfig` itself — mirrors
  // `procedureAssembler.projectRecordAccess.test.ts`'s fixture pattern.
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'gate-verify-procedure-'));
    mockGetProjectById.mockReturnValue({ id: 'proj-a', projectDir });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    mockGetProjectById.mockReset();
  });

  it('does not contain the "not practical for a bounded one-shot investigation" escape clause', () => {
    const procedure = buildGateVerifyProcedure(makeItem());
    expect(procedure).not.toMatch(/not practical for a bounded one-shot/i);
    expect(procedure).not.toMatch(
      /if that is not practical.*report `?needs-setup`? and\s+name the missing capability/is,
    );
  });

  it('still instructs the session to stage session.requestCapability and end the turn', () => {
    const procedure = buildGateVerifyProcedure(makeItem());
    expect(procedure).toMatch(
      /stage a `session\.requestCapability` intent naming that exact read/,
    );
    expect(procedure).toMatch(/and end the turn/);
  });

  it('still forbids fabricating a pass/fail to route around a permission denial', () => {
    const procedure = buildGateVerifyProcedure(makeItem());
    expect(procedure).toMatch(
      /never fabricate a pass\/fail to route around a permission denial/i,
    );
  });

  it('inlines the three root-cause locks and the needs-setup-when-not-located instruction', () => {
    const procedure = buildGateVerifyProcedure(makeItem());
    expect(procedure).toMatch(/\*\*The branch\.\*\*/);
    expect(procedure).toMatch(/\*\*The input that takes that branch\.\*\*/);
    expect(procedure).toMatch(
      /\*\*The fix that follows from that branch\.\*\*/,
    );
    expect(procedure).toMatch(
      /If you cannot write all three locks within budget, report `needs-setup`/,
    );
    expect(procedure).toContain('cause not located:');
    expect(procedure).toContain('existingTaskId');
    expect(procedure).toMatch(/Stage before the budget runs out/);
  });

  it('names both abstains and the condition distinguishing them', () => {
    const procedure = buildGateVerifyProcedure(makeItem());
    expect(procedure).toMatch(/`needs-setup`/);
    expect(procedure).toMatch(/`not-yet-triggerable`/);
    // The distinguishing condition: needs-setup requires a human to act
    // first; not-yet-triggerable is for a scenario/data that simply hasn't
    // occurred yet and just needs a later re-check.
    expect(procedure).toMatch(/a human must (act|perform)/i);
    expect(procedure).toMatch(/hasn't happened yet|has not happened yet/i);
  });

  it('states the two-question abstain test with operator-staged tell words mapping to needs-setup', () => {
    const procedure = buildGateVerifyProcedure(makeItem());
    expect(procedure).toMatch(/two questions, in order/);
    expect(procedure).toMatch(/dispatch, revoke, seed,\s+force, configure/);
    expect(procedure).toMatch(
      /report `needs-setup`, and make `evidence.found`/,
    );
  });

  it('rejects sampled, unrecognized-eventType, or no-read evidence for not-yet-triggerable', () => {
    const procedure = buildGateVerifyProcedure(makeItem());
    expect(procedure).toMatch(/covered its whole window/);
    expect(procedure).toMatch(/unfiltered newest-200 sample/);
    expect(procedure).toMatch(/eventTypeRecognized=false/);
    expect(procedure).toMatch(/or no read at all/);
    expect(procedure).toMatch(
      /report plain `needs-setup`\s+\(bounded-effort abstention\), never `not-yet-triggerable`/,
    );
  });

  it('no longer mandates a reclassify for unrecordable scenarios', () => {
    const procedure = buildGateVerifyProcedure(makeItem());
    expect(procedure).not.toContain(
      'reclassify is required whenever you concluded the item cannot be settled from the operational record by construction',
    );
    expect(procedure).not.toMatch(/never a bare\s+`?needs-setup/);
    expect(procedure).toMatch(
      /Do NOT reclassify just because no operational trace exists by\s+construction/,
    );
  });

  it('restricts Human-Observation reclassify to visual judgment and keeps needs-triage for unanswerable text', () => {
    const procedure = buildGateVerifyProcedure(makeItem());
    expect(procedure).toMatch(
      /only for what a\s+human must see with their own eyes: rendered UI, colour,\s+layout, wrapping, or a visual read of a running page/,
    );
    expect(procedure).toMatch(
      /`needs-triage` is for item text that is\s+unanswerable as written/,
    );
  });

  it('leaves the Human-Observation item branch unchanged', () => {
    const procedure = buildGateVerifyProcedure(
      makeItem({ classification: 'Human-Observation' }),
    );
    expect(procedure).toContain(
      'This item is classified **Human-Observation**: it describes ' +
        'UI/visual/interactive behavior (e.g. a rendered component, a ' +
        'visual layout, an interactive flow) that only a human observing ' +
        'the running app can judge. You cannot pass this item — reading ' +
        'component source to infer what renders is not verification. ' +
        'Always report `needs-setup`, even if you find strong ' +
        'operational evidence; attach whatever you found as advisory ' +
        'evidence for the human who will make the actual pass/fail call ' +
        'through the /gate flow.',
    );
    expect(procedure).not.toMatch(/Do NOT reclassify just because/);
  });

  it.each(['Read-Only', 'Human-Observation'] as const)(
    'tells a %s item how to read a spooled tool result, inside the Procedure section',
    (classification) => {
      const procedure = buildGateVerifyProcedure(makeItem({ classification }));
      const procIdx = procedure.indexOf('### Procedure');
      const spoolIdx = procedure.indexOf('Reading a spooled tool result');
      expect(procIdx).toBeGreaterThanOrEqual(0);
      expect(spoolIdx).toBeGreaterThan(procIdx);
      const para = procedure.slice(
        spoolIdx,
        procedure.indexOf('\n\n', spoolIdx),
      );
      expect(para).toMatch(/ONE Bash command on that absolute path/);
      expect(para).toMatch(/`sort`, `uniq -c` or `head`/);
      expect(para).toMatch(/`cd` prefix/);
      expect(para).toMatch(/`VAR=` prefix/);
      expect(para).toMatch(/`;` or `&&` chains/);
      expect(para).toMatch(/heredocs/);
      expect(para).toMatch(/`python3 -`/);
    },
  );

  it('falls back to a generic ad hoc read paragraph naming no script when the project declares no ad_hoc_read_command', () => {
    const procedure = buildGateVerifyProcedure(makeItem());
    expect(procedure).not.toContain('adhoc-query');
    expect(procedure).not.toContain('packages/backend/scripts/');
    expect(procedure).toMatch(/no dedicated MCP read tool/);
    expect(procedure).toMatch(
      /needs-setup.+should mean this specific request is pending, refused/s,
    );
  });

  it('names the project-declared ad hoc read command verbatim as the sanctioned route for a DB table with no dedicated MCP tool, before a needs-setup abstain', () => {
    writeFileSync(
      join(projectDir, '.claude-orchestrator.yml'),
      "ad_hoc_read_command: 'Bash(npx ts-node packages/backend/scripts/adhoc-query.ts:*)'\n",
    );
    const procedure = buildGateVerifyProcedure(makeItem());
    expect(procedure).toContain('packages/backend/scripts/adhoc-query.ts');
    expect(procedure).toMatch(
      /Bash\(npx ts-node packages\/backend\/scripts\/adhoc-query\.ts:\*\)/,
    );
    expect(procedure).toMatch(/no dedicated MCP read tool/);
    expect(procedure).toMatch(
      /needs-setup.+should mean this specific request is pending, refused/s,
    );

    // Offered before a needs-setup abstain: the capability mention must
    // appear ahead of the "Two abstains" needs-setup/not-yet-triggerable
    // discussion in the Procedure section.
    const capIdx = procedure.indexOf('adhoc-query.ts');
    const abstainIdx = procedure.indexOf('Two abstains, not one');
    expect(capIdx).toBeGreaterThanOrEqual(0);
    expect(abstainIdx).toBeGreaterThan(capIdx);
  });

  it('renders the ad hoc read paragraph from the same shared source procedureAssembler.ts exports, never a hand-rolled copy', () => {
    writeFileSync(
      join(projectDir, '.claude-orchestrator.yml'),
      "ad_hoc_read_command: 'Bash(npx ts-node packages/backend/scripts/adhoc-query.ts:*)'\n",
    );
    const procedure = buildGateVerifyProcedure(makeItem());
    const shared = renderAdHocReadCapability('proj-a').join('\n');
    expect(procedure).toContain(shared);
  });
});
