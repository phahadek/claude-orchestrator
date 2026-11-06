import { createHash } from 'crypto';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { fetchBaseBranch, mergeTreeOid } from './localBranchHelpers';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

export type CombinedTree =
  | {
      status: 'ok';
      treeOid: string;
      baseSha: string;
      /** Null only when the combined tree is empty. */
      contentHash: string | null;
    }
  | { status: 'conflict'; detail: string }
  | { status: 'error'; detail: string };

/**
 * Content hash of a git tree object, computed without a checkout. Same
 * file-order and file-bytes scheme as computeWholeTreeContentHash, so a clean
 * checkout of the tree hashes identically.
 */
async function hashTreeContent(
  repoDir: string,
  treeOid: string,
): Promise<string | null> {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-tree', '-r', '-z', treeOid],
    { cwd: repoDir, maxBuffer: 256 * 1024 * 1024 },
  );
  const entries: { file: string; oid: string }[] = [];
  for (const rec of stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [, type, oid] = rec.slice(0, tab).split(' ');
    if (type !== 'blob') continue;
    entries.push({ file: rec.slice(tab + 1), oid });
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const blobs = await readBlobs(
    repoDir,
    Array.from(new Set(entries.map((e) => e.oid))),
  );
  const hash = createHash('sha256');
  for (const { file, oid } of entries) {
    hash.update(file);
    hash.update('\0');
    hash.update(blobs.get(oid) ?? 'MISSING');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readBlobs(
  repoDir: string,
  oids: string[],
): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['cat-file', '--batch'], { cwd: repoDir });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited ${code}`));
      const buf = Buffer.concat(chunks);
      const out = new Map<string, Buffer>();
      let pos = 0;
      while (pos < buf.length) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl < 0) break;
        const [oid, type, sizeStr] = buf.toString('utf8', pos, nl).split(' ');
        if (type === 'missing') {
          pos = nl + 1;
          continue;
        }
        const size = Number(sizeStr);
        out.set(oid, buf.subarray(nl + 1, nl + 1 + size));
        pos = nl + 1 + size + 1;
      }
      resolve(out);
    });
    proc.stdin.end(oids.join('\n') + '\n');
  });
}

export async function readHeadOids(
  repoDir: string,
): Promise<{ headSha: string; headTree: string }> {
  const rev = async (spec: string): Promise<string> =>
    (
      await execFileAsync('git', ['rev-parse', spec], { cwd: repoDir })
    ).stdout.trim();
  return { headSha: await rev('HEAD'), headTree: await rev('HEAD^{tree}') };
}

/**
 * head ⊕ current base, checkout-free: fetches the base branch (best effort),
 * merge-trees the PR head against it, and hashes the resulting tree. This is
 * the tree a squash merge would land while base is unchanged.
 */
export async function resolveCombinedTree(args: {
  repoDir: string;
  headSha: string;
  baseBranch: string;
}): Promise<CombinedTree> {
  const { repoDir, headSha, baseBranch } = args;
  await fetchBaseBranch(repoDir, baseBranch);
  let baseSha: string;
  try {
    const remote = await execFileAsync(
      'git',
      ['rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`],
      { cwd: repoDir },
    ).catch(() =>
      execFileAsync(
        'git',
        ['rev-parse', '--verify', `${baseBranch}^{commit}`],
        {
          cwd: repoDir,
        },
      ),
    );
    baseSha = remote.stdout.trim();
  } catch (e) {
    return { status: 'error', detail: `cannot resolve base: ${e}` };
  }
  const merged = await mergeTreeOid(repoDir, headSha, baseSha);
  if (merged.status !== 'ok') return merged;
  try {
    return {
      status: 'ok',
      treeOid: merged.treeOid,
      baseSha,
      contentHash: await hashTreeContent(repoDir, merged.treeOid),
    };
  } catch (e) {
    return { status: 'error', detail: `cannot hash combined tree: ${e}` };
  }
}

const BOT_ENV = {
  GIT_AUTHOR_NAME: 'claude-orchestrator',
  GIT_AUTHOR_EMAIL: 'bot@claude-code.internal',
  GIT_COMMITTER_NAME: 'claude-orchestrator',
  GIT_COMMITTER_EMAIL: 'bot@claude-code.internal',
};

/** Deterministic per-session scratch location, a sibling of the session worktree. */
export function gateScratchPath(sessionWorktreePath: string): string {
  return path.join(
    path.dirname(sessionWorktreePath),
    '.gate-scratch',
    path.basename(sessionWorktreePath),
  );
}

async function removeScratch(repoDir: string, dir: string): Promise<void> {
  await execFileAsync('git', ['worktree', 'remove', '--force', dir], {
    cwd: repoDir,
  }).catch(() => undefined);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await execFileAsync('git', ['worktree', 'prune'], { cwd: repoDir }).catch(
    () => undefined,
  );
}

/**
 * Materializes the combined tree as a detached, gate-owned checkout and
 * bootstraps its dependencies; the caller must call `dispose` when done.
 * Never pushes and never touches the session worktree or branch: the only
 * writes into the shared repo are unreferenced objects and the scratch
 * worktree's own admin entry, both removed on exit.
 */
export async function createGateScratchTree(args: {
  repoDir: string;
  projectDir: string;
  sessionWorktreePath: string;
  headSha: string;
  treeOid: string;
}): Promise<{ path: string; dispose: () => Promise<void> }> {
  const { repoDir, projectDir, sessionWorktreePath, headSha, treeOid } = args;
  const dir = gateScratchPath(sessionWorktreePath);
  const dispose = (): Promise<void> =>
    removeScratch(repoDir, dir).catch((err) =>
      logger.warn(`[combinedTree] scratch cleanup failed for ${dir}: ${err}`),
    );
  await removeScratch(repoDir, dir);
  try {
    await fs.promises.mkdir(path.dirname(dir), { recursive: true });
    const { stdout } = await execFileAsync(
      'git',
      ['commit-tree', treeOid, '-p', headSha, '-m', 'gate combined tree'],
      { cwd: repoDir, env: { ...process.env, ...BOT_ENV } },
    );
    await execFileAsync(
      'git',
      ['worktree', 'add', '--detach', dir, stdout.trim()],
      { cwd: repoDir },
    );
    const bootstrap = loadOrchestratorConfig(projectDir).bootstrap_script;
    if (bootstrap) {
      await execFileAsync('bash', [bootstrap, dir], {
        cwd: projectDir,
        timeout: 600_000,
      });
    }
    return { path: dir, dispose };
  } catch (err) {
    await dispose();
    throw err;
  }
}
