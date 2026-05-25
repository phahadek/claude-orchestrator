import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GitHubClient } from './GitHubClient';

const execFileAsync = promisify(execFile);

export interface DiffSource {
  fetchDiff(): Promise<string>;
}

export class GitHubDiffSource implements DiffSource {
  constructor(
    private github: GitHubClient,
    private repo: string,
    private prNumber: number,
  ) {}

  async fetchDiff(): Promise<string> {
    const result = await this.github.fetchDiff(this.prNumber, this.repo);
    return result.diff;
  }
}

export class LocalDiffSource implements DiffSource {
  constructor(
    private worktreePath: string,
    private baseBranch: string,
    private headBranch: string,
  ) {}

  async fetchDiff(): Promise<string> {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', `${this.baseBranch}..${this.headBranch}`],
      { cwd: this.worktreePath },
    );
    return stdout;
  }
}
