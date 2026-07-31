import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { logger } from '../logger';
import { resolveConfigDir } from '../groom/groomLoad';
import { DeployBindings, validateDeployBindings } from './deployBindingsSchema';

export type LoadDeployBindingsResult =
  | { ok: true; bindings: DeployBindings; bindingsPath: string | null }
  | { ok: false; reason: string };

/**
 * Loads and runtime-validates the host-local
 * `<configDir>/projects/<basename(projectDir)>/deploy-bindings.yml` — never
 * the versioned git checkout, and never keyed by `DeployOrchestrator`'s
 * `project` (a registry id that can differ from the config-dir name, e.g.
 * `claude-dashboard` vs `claude-orchestrator`). Mirrors
 * `loadOrchestratorConfig`'s DEFAULTS-on-absent posture for the "no
 * resolvable config tree at all" case (yields an empty binding map, since
 * there's no path a project-scoped bindings file could even live at) and
 * `loadDeployPlaybook`'s fail-closed posture on a malformed present file.
 * An absent file *underneath a resolved config tree* also still yields an
 * empty map here — whether that's actually an error depends on whether the
 * playbook references any binding, which only `DeployOrchestrator`'s
 * preflight check (informed by the `bindingsPath` returned here) can know.
 */
export function loadDeployBindings(
  projectDir: string,
): LoadDeployBindingsResult {
  const configDir = resolveConfigDir(projectDir);
  if (!configDir) {
    return { ok: true, bindings: {}, bindingsPath: null };
  }

  const bindingsPath = path.join(
    configDir,
    'projects',
    path.basename(projectDir),
    'deploy-bindings.yml',
  );
  if (!fs.existsSync(bindingsPath)) {
    return { ok: true, bindings: {}, bindingsPath };
  }

  let raw: unknown;
  try {
    const contents = fs.readFileSync(bindingsPath, 'utf-8');
    raw = yaml.load(contents);
  } catch (err) {
    const reason = `failed to parse ${bindingsPath}: ${err}`;
    logger.warn(`[loadDeployBindings] ${reason}`);
    return { ok: false, reason };
  }

  const result = validateDeployBindings(raw);
  if ('errors' in result) {
    const reason = `invalid deploy bindings at ${bindingsPath}: ${result.errors.join('; ')}`;
    logger.warn(`[loadDeployBindings] ${reason}`);
    return { ok: false, reason };
  }

  return { ok: true, bindings: result.bindings, bindingsPath };
}
