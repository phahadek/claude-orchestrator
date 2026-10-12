import { getProjectByGithubRepo } from '../config';
import { logger } from '../logger';
import { setPauseReason } from '../db/queries';
import type { PullRequestRow } from '../db/types';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import type { SessionManager } from '../session/SessionManager';
import { emitTaskUpdated } from '../routes/tasks';
import type { GitHubClient } from './GitHubClient';

export interface MigrationNumberCollision {
  prFile: string;
  number: number;
  baseFile: string;
}

export type MigrationCollisionResult =
  | { ok: true }
  | {
      ok: false;
      collisions: MigrationNumberCollision[];
      nextFree: number;
    };

export interface MigrationGuardConfig {
  dir: string;
  filenamePattern: RegExp;
}

type GuardGithub = Pick<GitHubClient, 'getPRFiles' | 'listFilePathsAtRef'>;

function numberedFilesUnderDir(
  paths: string[],
  cfg: MigrationGuardConfig,
): Array<{ path: string; number: number }> {
  const prefix = `${cfg.dir.replace(/^\/+|\/+$/g, '')}/`;
  const out: Array<{ path: string; number: number }> = [];
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const name = p.slice(prefix.length);
    if (name.includes('/')) continue;
    const m = name.match(cfg.filenamePattern);
    if (!m || m[1] === undefined) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n)) out.push({ path: p, number: n });
  }
  return out;
}

/**
 * Throws if the PR's file list or the live base-branch tree can't be fetched —
 * callers must treat that as "do not merge" (fail closed): a duplicate number
 * on the base branch breaks every later deploy.
 */
export async function checkMigrationNumberCollision(
  github: GuardGithub,
  pr: { prNumber: number; repo: string; baseBranch: string },
  cfg: MigrationGuardConfig,
): Promise<MigrationCollisionResult> {
  const [prFiles, basePaths] = await Promise.all([
    github.getPRFiles(pr.repo, pr.prNumber),
    github.listFilePathsAtRef(pr.repo, pr.baseBranch),
  ]);

  const added = numberedFilesUnderDir(
    prFiles.filter((f) => f.status === 'added').map((f) => f.filename),
    cfg,
  );
  if (added.length === 0) return { ok: true };

  const baseFiles = numberedFilesUnderDir(basePaths, cfg);
  const baseByNumber = new Map<number, string>();
  for (const f of baseFiles) {
    if (!baseByNumber.has(f.number)) baseByNumber.set(f.number, f.path);
  }

  const collisions: MigrationNumberCollision[] = [];
  const seenInPr = new Map<number, string>();
  for (const f of added) {
    const baseFile = baseByNumber.get(f.number);
    if (baseFile !== undefined && baseFile !== f.path) {
      collisions.push({ prFile: f.path, number: f.number, baseFile });
      continue;
    }
    const sibling = seenInPr.get(f.number);
    if (sibling !== undefined) {
      collisions.push({ prFile: f.path, number: f.number, baseFile: sibling });
    } else {
      seenInPr.set(f.number, f.path);
    }
  }
  if (collisions.length === 0) return { ok: true };

  const nextFree = baseFiles.reduce((max, f) => Math.max(max, f.number), 0) + 1;
  return { ok: false, collisions, nextFree };
}

export type MigrationGuardOutcome =
  | { ok: true }
  | { ok: false; kind: 'collision' | 'check_failed'; message: string };

/**
 * Merge-time entry point shared by AutoMerger and the operator merge route.
 * No-op (ok) for a project without a `migrations` config block. On a
 * collision it records the migration_number_collision pause and routes a
 * renumber request to the PR's session; with no session the pause alone is
 * left for the operator.
 */
export async function guardMigrationNumbersBeforeMerge(
  github: GuardGithub,
  sessions: Pick<SessionManager, 'enqueueFeedback'> | undefined,
  pr: PullRequestRow,
): Promise<MigrationGuardOutcome> {
  const project = getProjectByGithubRepo(pr.repo);
  if (!project) return { ok: true };
  const migrations = loadOrchestratorConfig(project.projectDir).migrations;
  if (!migrations) return { ok: true };

  const baseBranch = pr.base_branch ?? 'dev';
  let result: MigrationCollisionResult;
  try {
    result = await checkMigrationNumberCollision(
      github,
      { prNumber: pr.pr_number, repo: pr.repo, baseBranch },
      {
        dir: migrations.dir,
        // eslint-disable-next-line security/detect-non-literal-regexp -- pattern comes from the project's own .claude-orchestrator.yml config, already regex-validated by loadOrchestratorConfig.
        filenamePattern: new RegExp(migrations.filename_pattern),
      },
    );
  } catch (err) {
    const message = `migration-number check could not read ${pr.repo}@${baseBranch}: ${(err as Error).message}`;
    logger.warn(
      `[migrationNumberGuard] PR #${pr.pr_number}: ${message} — failing closed`,
    );
    return { ok: false, kind: 'check_failed', message };
  }
  if (result.ok) return { ok: true };

  const owners = result.collisions
    .map(
      (c) =>
        `${c.prFile} uses number ${c.number}, already owned by ${c.baseFile}`,
    )
    .join('; ');
  const detail = `${owners}. Next free number on ${baseBranch}: ${result.nextFree}.`;
  setPauseReason(pr.pr_number, pr.repo, 'migration_number_collision', detail);
  if (pr.task_id) emitTaskUpdated(pr.task_id);
  logger.info(
    `[migrationNumberGuard] PR #${pr.pr_number}: migration number collision — ${detail}`,
  );

  if (pr.session_id && sessions) {
    const feedback =
      `PR #${pr.pr_number} cannot merge: its new migration number collides with ${baseBranch}. ${detail} ` +
      `Rename to the next free number on the base branch and update every place the number appears in the file, then push.`;
    try {
      await sessions.enqueueFeedback(
        pr.session_id,
        'migration-collision',
        feedback,
      );
    } catch (err) {
      logger.warn(
        `[migrationNumberGuard] PR #${pr.pr_number}: enqueueFeedback failed: ${(err as Error).message}`,
      );
    }
  }
  return { ok: false, kind: 'collision', message: detail };
}
