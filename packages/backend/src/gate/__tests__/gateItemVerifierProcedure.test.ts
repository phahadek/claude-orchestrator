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

import { describe, it, expect } from 'vitest';
import { buildGateVerifyProcedure } from '../gateItemVerifier';
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

  it('names the read-only ad hoc query capability as the sanctioned route for a DB table with no dedicated MCP tool, before a needs-setup abstain', () => {
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
});
