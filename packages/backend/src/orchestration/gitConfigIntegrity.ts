import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger';
import { getAllProjects } from '../config';
import type { ProjectConfig } from '../config';
import { recordEvent } from '../audit/AuditLog';

const execAsync = promisify(exec);

const BACKUP_FILENAME = 'config.orchestrator-backup';

function gitConfigPath(repoDir: string): string {
  return path.join(repoDir, '.git', 'config');
}

function gitConfigBackupPath(repoDir: string): string {
  return path.join(repoDir, '.git', BACKUP_FILENAME);
}

/** Returns true if the file is missing, empty, or consists entirely of NUL bytes. */
export function isConfigCorrupted(configPath: string): boolean {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(configPath);
  } catch {
    return true;
  }
  if (buf.length === 0) return true;
  return buf.every((b) => b === 0);
}

/** Returns true if `git config --list` exits cleanly in repoDir. */
async function isConfigParseable(repoDir: string): Promise<boolean> {
  try {
    await execAsync('git config --list', { cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}

function snapshotConfig(configPath: string, backupPath: string): void {
  fs.copyFileSync(configPath, backupPath);
}

function restoreConfig(backupPath: string, configPath: string): void {
  fs.copyFileSync(backupPath, configPath);
}

export interface GitConfigCheckResult {
  healthy: boolean;
  repaired: boolean;
  backupAvailable: boolean;
}

/**
 * Validate the main repo .git/config for a single project and repair it from
 * the sidecar backup if corrupted.  Returns a result object so the boot step
 * can decide whether to surface a warning when repair was impossible.
 */
export async function validateAndRepairGitConfig(
  repoDir: string,
  projectId: string,
): Promise<GitConfigCheckResult> {
  const configPath = gitConfigPath(repoDir);
  const backupPath = gitConfigBackupPath(repoDir);
  const backupAvailable = fs.existsSync(backupPath);

  const byteCorrupted = isConfigCorrupted(configPath);
  const parseable = byteCorrupted ? false : await isConfigParseable(repoDir);

  if (!byteCorrupted && parseable) {
    // Config is healthy — refresh the backup snapshot.
    try {
      snapshotConfig(configPath, backupPath);
      logger.debug(
        `[gitConfigIntegrity] snapshotted healthy config for project ${projectId}`,
      );
    } catch (err) {
      logger.warn(
        `[gitConfigIntegrity] failed to snapshot config for project ${projectId}: ${err}`,
      );
    }
    return { healthy: true, repaired: false, backupAvailable };
  }

  // Config is corrupted.
  const reason = byteCorrupted ? 'empty_or_null_bytes' : 'parse_error';
  logger.warn(
    `[gitConfigIntegrity] corrupted .git/config detected for project ${projectId} (reason: ${reason})`,
  );

  if (!backupAvailable) {
    logger.error(
      `[gitConfigIntegrity] no backup available for project ${projectId} — cannot repair`,
    );
    return { healthy: false, repaired: false, backupAvailable: false };
  }

  try {
    restoreConfig(backupPath, configPath);
  } catch (err) {
    logger.error(
      `[gitConfigIntegrity] failed to restore backup for project ${projectId}: ${err}`,
    );
    return { healthy: false, repaired: false, backupAvailable: true };
  }

  recordEvent({
    event_type: 'repo_git_config_repaired',
    actor_type: 'system',
    project_id: projectId,
    payload: {
      repo_dir: repoDir,
      reason,
      backup_path: backupPath,
    },
  });

  logger.info(
    `[gitConfigIntegrity] restored .git/config from backup for project ${projectId}`,
  );
  return { healthy: true, repaired: true, backupAvailable: true };
}

export async function runGitConfigIntegrityCheck(options?: {
  listProjects?: () => ProjectConfig[];
}): Promise<void> {
  const listProjects = options?.listProjects ?? getAllProjects;
  const projects = listProjects();

  for (const project of projects) {
    try {
      await validateAndRepairGitConfig(project.projectDir, project.id);
    } catch (err) {
      logger.error(
        `[gitConfigIntegrity] unexpected error checking project ${project.id}: ${err}`,
      );
    }
  }
}
