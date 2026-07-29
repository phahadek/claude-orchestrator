import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { logger } from '../logger';
import { DeployPlaybook, validatePlaybook } from './playbookSchema';

export type LoadPlaybookResult =
  | { ok: true; playbook: DeployPlaybook }
  | { ok: false; reason: string };

/**
 * Loads and runtime-validates `<projectDir>/.claude-deploy-playbook.yml`, read
 * fresh on every call — no server restart needed to pick up changes. Unlike
 * `loadOrchestratorConfig`, an absent or invalid playbook is never defaulted:
 * `/deploy` stops on a missing or malformed playbook rather than improvising,
 * per the `/deploy` playbook contract.
 */
export function loadDeployPlaybook(projectDir: string): LoadPlaybookResult {
  const playbookPath = path.join(projectDir, '.claude-deploy-playbook.yml');
  if (!fs.existsSync(playbookPath)) {
    return {
      ok: false,
      reason: `no deploy playbook found at ${playbookPath}`,
    };
  }

  let raw: unknown;
  try {
    const contents = fs.readFileSync(playbookPath, 'utf-8');
    raw = yaml.load(contents);
  } catch (err) {
    const reason = `failed to parse ${playbookPath}: ${err}`;
    logger.warn(`[loadPlaybook] ${reason}`);
    return { ok: false, reason };
  }

  const result = validatePlaybook(raw);
  if ('errors' in result) {
    const reason = `invalid deploy playbook at ${playbookPath}: ${result.errors.join('; ')}`;
    logger.warn(`[loadPlaybook] ${reason}`);
    return { ok: false, reason };
  }

  return { ok: true, playbook: result };
}
