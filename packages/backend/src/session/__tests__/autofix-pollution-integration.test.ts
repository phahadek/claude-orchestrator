/**
 * Integration tests for AC4 and AC5: verify that the autofix + pollution check
 * pipeline prevents CLAUDE.md from appearing in the final PR diff.
 *
 * These tests use:
 *  - A real temporary git repo with a bare-remote clone (no mocked child_process)
 *  - Real prettier (resolved from workspace node_modules) as the autofix command
 *  - A minimal GitHubClient mock (just fetchPR / getPRFiles / createIssueComment)
 *  - AuditLog mocked to avoid SQLite dependency
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { runAutofix } from '../autofix-runner';
import { runFilePollutionCheck } from '../filePollutionCheck';
import type { GitHubClient } from '../../github/GitHubClient';

vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));

// Resolve prettier from the workspace so the command works from any temp dir.
const PRETTIER_BIN = require
  .resolve('prettier/bin/prettier.cjs')
  .replace(/\\/g, '/');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

describe('integration: autofix + file pollution check pipeline', () => {
  let tmpDir: string;
  let worktreeDir: string;
  let remoteDir: string;
  let baseBranch: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollution-int-'));
    worktreeDir = path.join(tmpDir, 'worktree');
    remoteDir = path.join(tmpDir, 'remote.git');
    fs.mkdirSync(worktreeDir);
    fs.mkdirSync(remoteDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Bootstrap the git repos and push an initial commit.
   *
   * @param withClaudeMd  true → CLAUDE.md is committed on the base branch (AC4).
   *                      false → CLAUDE.md is written to disk but NOT committed (AC5).
   */
  function initRepo(withClaudeMd: boolean): void {
    // Bare remote
    git(['init', '--bare'], remoteDir);

    // Worktree
    git(['init'], worktreeDir);
    git(['config', 'user.email', 'test@test.com'], worktreeDir);
    git(['config', 'user.name', 'Test'], worktreeDir);
    git(['remote', 'add', 'origin', remoteDir], worktreeDir);

    // index.js — already correctly formatted so prettier leaves it alone on
    // the initial commit. It gets modified on the feature branch so that the
    // feature branch has at least one "real" commit distinct from the base.
    fs.writeFileSync(path.join(worktreeDir, 'index.js'), 'const x = 1;\n');

    if (withClaudeMd) {
      // Content that prettier WILL reformat: unordered list bullets `*` → `-`.
      // This guarantees the file appears in the autofix commit.
      fs.writeFileSync(
        path.join(worktreeDir, 'CLAUDE.md'),
        '# Title\n\n* item one\n* item two\n',
      );
    }

    git(['add', '.'], worktreeDir);
    git(['commit', '-m', 'initial'], worktreeDir);

    // Capture the default branch name (master or main depending on git config).
    baseBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeDir).trim();
    git(['push', '-u', 'origin', baseBranch], worktreeDir);

    // Feature branch with one commit on top of base.
    git(['checkout', '-b', 'feature/test'], worktreeDir);
    fs.appendFileSync(path.join(worktreeDir, 'index.js'), '// feature\n');
    git(['add', 'index.js'], worktreeDir);
    git(['commit', '-m', 'feat: add feature'], worktreeDir);
    git(['push', '-u', 'origin', 'feature/test'], worktreeDir);

    if (!withClaudeMd) {
      // AC5: CLAUDE.md exists on disk as an UNTRACKED file — not committed to git.
      // When autofix runs `git add -A`, it will be staged as a new file.
      fs.writeFileSync(
        path.join(worktreeDir, 'CLAUDE.md'),
        '# Title\n\n* item one\n* item two\n',
      );
    }
  }

  // ── AC4 ─────────────────────────────────────────────────────────────────────

  it(
    'AC4: tracked CLAUDE.md formatted by prettier is absent from the final PR diff',
    async () => {
      initRepo(true);

      // Step 1 — run real prettier as the autofix command
      const autofixResult = await runAutofix(
        worktreeDir,
        worktreeDir,
        [`node "${PRETTIER_BIN}" --write .`],
        () => {},
      );

      expect(
        autofixResult.commitSha,
        'prettier must produce a diff (CLAUDE.md bullet normalisation)',
      ).toBeDefined();

      const autofixChangedFiles = git(
        ['diff', '--name-only', 'HEAD~1', 'HEAD'],
        worktreeDir,
      );
      expect(
        autofixChangedFiles,
        'autofix commit must include CLAUDE.md',
      ).toContain('CLAUDE.md');

      // Step 2 — build a GitHub mock from the real post-autofix state
      const headSha = git(['rev-parse', 'HEAD'], worktreeDir).trim();
      const changedFiles = autofixChangedFiles.split('\n').filter(Boolean);

      const github = {
        fetchPR: vi.fn().mockResolvedValue({ headSha }),
        getPRFiles: vi.fn().mockResolvedValue(changedFiles),
        createIssueComment: vi.fn().mockResolvedValue(undefined),
      } as unknown as GitHubClient;

      // Step 3 — run the pollution check
      const result = await runFilePollutionCheck({
        github,
        worktreePath: worktreeDir,
        repo: 'owner/repo',
        prNumber: 1,
        baseBranch,
        sessionId: null,
        projectId: null,
        taskId: null,
      });

      expect(
        result.revertCommitSha,
        'pollution check must produce a revert commit',
      ).not.toBeNull();

      // Step 4 — final diff: CLAUDE.md must be absent
      const finalDiff = git(
        ['diff', '--name-only', `origin/${baseBranch}`, 'HEAD'],
        worktreeDir,
      );
      expect(
        finalDiff,
        'CLAUDE.md must not appear in the final PR diff after revert',
      ).not.toContain('CLAUDE.md');
    },
    30_000,
  );

  // ── AC5 ─────────────────────────────────────────────────────────────────────

  it(
    'AC5: untracked CLAUDE.md staged by git add -A is absent from the final PR diff',
    async () => {
      initRepo(false); // creates untracked CLAUDE.md

      // Step 1 — run real prettier; it will format the untracked CLAUDE.md,
      // then runAutofix's `git add -A` will stage it as a brand-new file.
      const autofixResult = await runAutofix(
        worktreeDir,
        worktreeDir,
        [`node "${PRETTIER_BIN}" --write .`],
        () => {},
      );

      expect(
        autofixResult.commitSha,
        'autofix must commit the new untracked CLAUDE.md',
      ).toBeDefined();

      const autofixChangedFiles = git(
        ['diff', '--name-only', 'HEAD~1', 'HEAD'],
        worktreeDir,
      );
      expect(
        autofixChangedFiles,
        'autofix commit must include CLAUDE.md (new file)',
      ).toContain('CLAUDE.md');

      // Step 2 — build GitHub mock
      const headSha = git(['rev-parse', 'HEAD'], worktreeDir).trim();
      const changedFiles = autofixChangedFiles.split('\n').filter(Boolean);

      const github = {
        fetchPR: vi.fn().mockResolvedValue({ headSha }),
        getPRFiles: vi.fn().mockResolvedValue(changedFiles),
        createIssueComment: vi.fn().mockResolvedValue(undefined),
      } as unknown as GitHubClient;

      // Step 3 — run pollution check (uses `git rm -f` for files not on base branch)
      const result = await runFilePollutionCheck({
        github,
        worktreePath: worktreeDir,
        repo: 'owner/repo',
        prNumber: 1,
        baseBranch,
        sessionId: null,
        projectId: null,
        taskId: null,
      });

      expect(
        result.revertCommitSha,
        'pollution check must produce a revert commit',
      ).not.toBeNull();

      // Step 4 — final diff: CLAUDE.md must be absent
      const finalDiff = git(
        ['diff', '--name-only', `origin/${baseBranch}`, 'HEAD'],
        worktreeDir,
      );
      expect(
        finalDiff,
        'CLAUDE.md must not appear in the final PR diff after removal',
      ).not.toContain('CLAUDE.md');
    },
    30_000,
  );
});
