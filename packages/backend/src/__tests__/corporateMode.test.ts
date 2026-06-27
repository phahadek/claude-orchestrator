import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries.js', () => ({
  getSetting: vi.fn().mockReturnValue(undefined),
}));

import { getSetting } from '../db/queries.js';
import {
  getCorporateMode,
  _resetCorporateModeCache,
} from '../config/corporateMode.js';

beforeEach(() => {
  _resetCorporateModeCache();
  vi.clearAllMocks();
  vi.mocked(getSetting).mockReturnValue(undefined);
  delete process.env.ORCHESTRATOR_MODE;
});

describe('getCorporateMode', () => {
  it('returns enabled=false, envLocked=false when neither env nor settings is set', () => {
    const result = getCorporateMode();
    expect(result.enabled).toBe(false);
    expect(result.envLocked).toBe(false);
  });

  it('returns enabled=true, envLocked=true when ORCHESTRATOR_MODE=corporate', () => {
    process.env.ORCHESTRATOR_MODE = 'corporate';
    const result = getCorporateMode();
    expect(result.enabled).toBe(true);
    expect(result.envLocked).toBe(true);
  });

  it('returns enabled=true, envLocked=false when settings-table has corporate_mode=corporate', () => {
    vi.mocked(getSetting).mockReturnValue('corporate');
    const result = getCorporateMode();
    expect(result.enabled).toBe(true);
    expect(result.envLocked).toBe(false);
  });

  it('env wins over settings-table (env=personal overrides settings=corporate)', () => {
    process.env.ORCHESTRATOR_MODE = 'personal';
    vi.mocked(getSetting).mockReturnValue('corporate');
    const result = getCorporateMode();
    expect(result.enabled).toBe(false);
    expect(result.envLocked).toBe(true);
    expect(getSetting).not.toHaveBeenCalled();
  });

  it('when enabled=true, all 5 gates are true', () => {
    process.env.ORCHESTRATOR_MODE = 'corporate';
    const { gates } = getCorporateMode();
    expect(gates.dockerMandatory).toBe(true);
    expect(gates.requireHumanApproval).toBe(true);
    expect(gates.requireZDR).toBe(true);
    expect(gates.validatePRBody).toBe(true);
    expect(gates.secretsViaSeam).toBe(true);
  });

  it('when enabled=false, all 5 gates are false', () => {
    const { gates } = getCorporateMode();
    expect(gates.dockerMandatory).toBe(false);
    expect(gates.requireHumanApproval).toBe(false);
    expect(gates.requireZDR).toBe(false);
    expect(gates.validatePRBody).toBe(false);
    expect(gates.secretsViaSeam).toBe(false);
  });
});
