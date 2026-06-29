import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  'ORCHESTRATOR_GATE_SECRETS_VIA_SEAM',
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

  it('per-gate override flips one gate while others follow mode default (personal + requireZDR=true)', () => {
    process.env.ORCHESTRATOR_GATE_REQUIRE_ZDR = 'true';
    const { gates } = getCorporateMode();
    expect(gates.requireZDR).toBe(true);
    expect(gates.dockerMandatory).toBe(false);
    expect(gates.requireHumanApproval).toBe(false);
    expect(gates.validatePRBody).toBe(false);
    expect(gates.secretsViaSeam).toBe(false);
  });

  it('per-gate override flips one gate while others follow mode default (corporate + dockerMandatory=false)', () => {
    process.env.ORCHESTRATOR_MODE = 'corporate';
    process.env.ORCHESTRATOR_GATE_DOCKER_MANDATORY = 'false';
    const { gates } = getCorporateMode();
    expect(gates.dockerMandatory).toBe(false);
    expect(gates.requireHumanApproval).toBe(true);
    expect(gates.requireZDR).toBe(true);
    expect(gates.validatePRBody).toBe(true);
    expect(gates.secretsViaSeam).toBe(true);
  });

  it('multiple per-gate overrides are applied independently', () => {
    process.env.ORCHESTRATOR_GATE_REQUIRE_HUMAN_APPROVAL = 'true';
    process.env.ORCHESTRATOR_GATE_VALIDATE_PR_BODY = 'true';
    const { gates } = getCorporateMode();
    expect(gates.requireHumanApproval).toBe(true);
    expect(gates.validatePRBody).toBe(true);
    expect(gates.dockerMandatory).toBe(false);
    expect(gates.requireZDR).toBe(false);
    expect(gates.secretsViaSeam).toBe(false);
  });

  it('override wins over mode: personal mode + secretsViaSeam=true', () => {
    process.env.ORCHESTRATOR_MODE = 'personal';
    process.env.ORCHESTRATOR_GATE_SECRETS_VIA_SEAM = 'true';
    const { gates } = getCorporateMode();
    expect(gates.secretsViaSeam).toBe(true);
    expect(gates.dockerMandatory).toBe(false);
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
