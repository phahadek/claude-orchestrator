import { typedGetSetting } from './settings';

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

  const dbVal = typedGetSetting('corporate_mode'); // 'corporate' | 'personal', default 'personal'
  const enabled = dbVal === 'corporate';
  cachedConfig = { enabled, envLocked: false, gates: buildGates(enabled) };
  return cachedConfig;
}

export function _resetCorporateModeCache(): void {
  cachedConfig = null;
}
