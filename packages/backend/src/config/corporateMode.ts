import { getSetting } from '../db/queries';

export interface CorporateModeGates {
  dockerMandatory: boolean;
  requireHumanApproval: boolean;
  requireZDR: boolean;
  validatePRBody: boolean;
  secretsViaSeam: boolean;
}

export interface CorporateModeConfig {
  enabled: boolean;
  envLocked: boolean;
  gates: CorporateModeGates;
}

let cachedConfig: CorporateModeConfig | null = null;

function buildGates(enabled: boolean): CorporateModeGates {
  return {
    dockerMandatory: enabled,
    requireHumanApproval: enabled,
    requireZDR: enabled,
    validatePRBody: enabled,
    secretsViaSeam: enabled,
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

  const dbVal = getSetting('corporate_mode');
  if (dbVal === 'corporate' || dbVal === 'personal') {
    const enabled = dbVal === 'corporate';
    cachedConfig = { enabled, envLocked: false, gates: buildGates(enabled) };
    return cachedConfig;
  }

  cachedConfig = { enabled: false, envLocked: false, gates: buildGates(false) };
  return cachedConfig;
}

export function _resetCorporateModeCache(): void {
  cachedConfig = null;
}
