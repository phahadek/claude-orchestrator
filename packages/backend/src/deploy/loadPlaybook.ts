import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';
import { logger } from '../logger';
import {
  DeployPlaybook,
  deployRunWarnings,
  validatePlaybook,
} from './playbookSchema';

export type LoadPlaybookResult =
  | { ok: true; playbook: DeployPlaybook; warnings?: string[] }
  | { ok: false; reason: string };

const PLAYBOOK_FILE = '.claude-deploy-playbook.yml';

/**
 * Loads and runtime-validates `<projectDir>/.claude-deploy-playbook.yml` from
 * the working tree, read fresh on every call — no server restart needed to
 * pick up changes. Deploy execution must not use this (see
 * `loadDeployPlaybookAt`); it is for display of the checkout's current state.
 * Unlike `loadOrchestratorConfig`, an absent or invalid playbook is never
 * defaulted: `/deploy` stops on a missing or malformed playbook rather than
 * improvising, per the `/deploy` playbook contract.
 */
export function loadDeployPlaybook(projectDir: string): LoadPlaybookResult {
  const playbookPath = path.join(projectDir, PLAYBOOK_FILE);
  if (!fs.existsSync(playbookPath)) {
    return {
      ok: false,
      reason: `no deploy playbook found at ${playbookPath}`,
    };
  }

  let contents: string;
  try {
    contents = fs.readFileSync(playbookPath, 'utf-8');
  } catch (err) {
    const reason = `failed to parse ${playbookPath}: ${err}`;
    logger.warn(`[loadPlaybook] ${reason}`);
    return { ok: false, reason };
  }
  return parseAndValidate(contents, playbookPath);
}

/**
 * Loads and validates the playbook as committed at `sha`
 * (`git show <sha>:.claude-deploy-playbook.yml`), leaving the working tree
 * untouched, so a deploy runs the playbook of the commit it deploys rather
 * than the pre-merge checkout's.
 */
export function loadDeployPlaybookAt(
  projectDir: string,
  sha: string,
): LoadPlaybookResult {
  const label = `${sha}:${PLAYBOOK_FILE}`;
  const res = spawnSync('git', ['-C', projectDir, 'show', label], {
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    const detail = (res.error?.message ?? res.stderr ?? '').trim();
    const reason = `no deploy playbook found at ${label} in ${projectDir}${detail ? `: ${detail}` : ''}`;
    logger.warn(`[loadPlaybook] ${reason}`);
    return { ok: false, reason };
  }
  return parseAndValidate(res.stdout, `${projectDir}@${label}`);
}

function parseAndValidate(
  contents: string,
  playbookPath: string,
): LoadPlaybookResult {
  let raw: unknown;
  try {
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

  const warnings = deployRunWarnings(result);
  const warnKey = `${playbookPath}:${crypto
    .createHash('sha256')
    .update(JSON.stringify(result))
    .digest('hex')}`;
  if (warnings.length > 0 && !warnedPlaybooks.has(warnKey)) {
    warnedPlaybooks.add(warnKey);
    for (const warning of warnings) {
      logger.warn(`[loadPlaybook] ${playbookPath}: ${warning}`);
    }
  }
  return { ok: true, playbook: result, warnings };
}

/** Playbook (path + content hash) pairs whose deploy-run warnings were already logged this process. */
const warnedPlaybooks = new Set<string>();

/** Test hook: forget which playbooks have already warned. */
export function resetPlaybookWarningsForTests(): void {
  warnedPlaybooks.clear();
}
