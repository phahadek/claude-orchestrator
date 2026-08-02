import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/queries.js', () => ({
  getSetting: vi.fn().mockReturnValue(undefined),
}));

import { getSetting } from '../db/queries.js';
import {
  getCorporateMode,
  _resetCorporateModeCache,
} from '../config/corporateMode.js';

const GATE_ENV_VARS = [
  'ORCHESTRATOR_GATE_DOCKER_MANDATORY',
  'ORCHESTRATOR_GATE_REQUIRE_HUMAN_APPROVAL',
  'ORCHESTRATOR_GATE_REQUIRE_ZDR',
  'ORCHESTRATOR_GATE_VALIDATE_PR_BODY',
];

beforeEach(() => {
  _resetCorporateModeCache();
  vi.clearAllMocks();
  vi.mocked(getSetting).mockReturnValue(undefined);
  delete process.env.ORCHESTRATOR_MODE;
  for (const v of GATE_ENV_VARS) delete process.env[v];
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

  it('when enabled=true, all 4 gates are true', () => {
    process.env.ORCHESTRATOR_MODE = 'corporate';
    const { gates } = getCorporateMode();
    expect(gates.dockerMandatory).toBe(true);
    expect(gates.requireHumanApproval).toBe(true);
    expect(gates.requireZDR).toBe(true);
    expect(gates.validatePRBody).toBe(true);
  });

  it('when enabled=false, all 4 gates are false', () => {
    const { gates } = getCorporateMode();
    expect(gates.dockerMandatory).toBe(false);
    expect(gates.requireHumanApproval).toBe(false);
    expect(gates.requireZDR).toBe(false);
    expect(gates.validatePRBody).toBe(false);
  });

  it('per-gate override flips one gate while others follow mode default (personal + requireZDR=true)', () => {
    process.env.ORCHESTRATOR_GATE_REQUIRE_ZDR = 'true';
    const { gates } = getCorporateMode();
    expect(gates.requireZDR).toBe(true);
    expect(gates.dockerMandatory).toBe(false);
    expect(gates.requireHumanApproval).toBe(false);
    expect(gates.validatePRBody).toBe(false);
  });

  it('per-gate override flips one gate while others follow mode default (corporate + dockerMandatory=false)', () => {
    process.env.ORCHESTRATOR_MODE = 'corporate';
    process.env.ORCHESTRATOR_GATE_DOCKER_MANDATORY = 'false';
    const { gates } = getCorporateMode();
    expect(gates.dockerMandatory).toBe(false);
    expect(gates.requireHumanApproval).toBe(true);
    expect(gates.requireZDR).toBe(true);
    expect(gates.validatePRBody).toBe(true);
  });

  it('multiple per-gate overrides are applied independently', () => {
    process.env.ORCHESTRATOR_GATE_REQUIRE_HUMAN_APPROVAL = 'true';
    process.env.ORCHESTRATOR_GATE_VALIDATE_PR_BODY = 'true';
    const { gates } = getCorporateMode();
    expect(gates.requireHumanApproval).toBe(true);
    expect(gates.validatePRBody).toBe(true);
    expect(gates.dockerMandatory).toBe(false);
    expect(gates.requireZDR).toBe(false);
  });

  it('with no overrides, behavior is identical to today: corporate = all on', () => {
    process.env.ORCHESTRATOR_MODE = 'corporate';
    const { gates } = getCorporateMode();
    const allOn = Object.values(gates).every(Boolean);
    expect(allOn).toBe(true);
  });

  it('with no overrides, behavior is identical to today: personal = all off', () => {
    process.env.ORCHESTRATOR_MODE = 'personal';
    const { gates } = getCorporateMode();
    const allOff = Object.values(gates).every((v) => !v);
    expect(allOff).toBe(true);
  });
});

describe('getCorporateMode — CORPORATE_MODE deprecated alias', () => {
  const originalCorporateMode = process.env.CORPORATE_MODE;

  beforeEach(() => {
    delete process.env.CORPORATE_MODE;
  });

  afterEach(() => {
    if (originalCorporateMode === undefined) {
      delete process.env.CORPORATE_MODE;
    } else {
      process.env.CORPORATE_MODE = originalCorporateMode;
    }
  });

  it('enables corporate mode when only CORPORATE_MODE=true is set', () => {
    process.env.CORPORATE_MODE = 'true';
    const result = getCorporateMode();
    expect(result.enabled).toBe(true);
  });

  it('logs a deprecation warning once when resolved via the CORPORATE_MODE alias', () => {
    process.env.CORPORATE_MODE = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getCorporateMode();
    getCorporateMode();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/deprecated/i);
    warnSpy.mockRestore();
  });

  it('an explicit settings row wins over the CORPORATE_MODE alias', () => {
    process.env.CORPORATE_MODE = 'true';
    vi.mocked(getSetting).mockReturnValue('personal');
    const result = getCorporateMode();
    expect(result.enabled).toBe(false);
  });
});
