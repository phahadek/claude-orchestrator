import { typedGetSetting } from './settings';
import { getSetting } from '../db/queries';
import { logger } from '../logger';

interface CorporateModeGates {
  dockerMandatory: boolean;
  requireHumanApproval: boolean;
  requireZDR: boolean;
  validatePRBody: boolean;
}

export interface CorporateModeConfig {
  enabled: boolean;
  envLocked: boolean;
  gates: CorporateModeGates;
}

let cachedConfig: CorporateModeConfig | null = null;
let deprecationWarned = false;

// Per-gate env var names. Precedence: env-var override > mode default.
// Set to "true" or "false" to override the corporate-mode default for that gate.
const GATE_ENV_VARS: Record<keyof CorporateModeGates, string> = {
  dockerMandatory: 'ORCHESTRATOR_GATE_DOCKER_MANDATORY',
  requireHumanApproval: 'ORCHESTRATOR_GATE_REQUIRE_HUMAN_APPROVAL',
  requireZDR: 'ORCHESTRATOR_GATE_REQUIRE_ZDR',
  validatePRBody: 'ORCHESTRATOR_GATE_VALIDATE_PR_BODY',
};

function resolveGate(
  gate: keyof CorporateModeGates,
  modeDefault: boolean,
): boolean {
  const raw = process.env[GATE_ENV_VARS[gate]];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return modeDefault;
}

function buildGates(modeDefault: boolean): CorporateModeGates {
  return {
    dockerMandatory: resolveGate('dockerMandatory', modeDefault),
    requireHumanApproval: resolveGate('requireHumanApproval', modeDefault),
    requireZDR: resolveGate('requireZDR', modeDefault),
    validatePRBody: resolveGate('validatePRBody', modeDefault),
  };
}

export function getCorporateMode(): CorporateModeConfig {
  if (cachedConfig) return cachedConfig;

  const envVal = process.env.ORCHESTRATOR_MODE;
  if (envVal === 'corporate' || envVal === 'personal') {
    const enabled = envVal === 'corporate';
    cachedConfig = { enabled, envLocked: true, gates: buildGates(enabled) };
    return cachedConfig;
  }

  // Deprecated alias: honored only when no ORCHESTRATOR_MODE and no explicit
  // settings row exist, so an explicit settings value always wins.
  const rawDbVal = getSetting('corporate_mode');
  if (rawDbVal == null && process.env.CORPORATE_MODE === 'true') {
    if (!deprecationWarned) {
      deprecationWarned = true;
      logger.warn(
        '[corporateMode] CORPORATE_MODE env var is deprecated — set ORCHESTRATOR_MODE=corporate or the corporate_mode setting instead.',
      );
    }
    cachedConfig = { enabled: true, envLocked: false, gates: buildGates(true) };
    return cachedConfig;
  }

  const dbVal = typedGetSetting('corporate_mode'); // 'corporate' | 'personal', default 'personal'
  const enabled = dbVal === 'corporate';
  cachedConfig = { enabled, envLocked: false, gates: buildGates(enabled) };
  return cachedConfig;
}

export function _resetCorporateModeCache(): void {
  cachedConfig = null;
  deprecationWarned = false;
}
