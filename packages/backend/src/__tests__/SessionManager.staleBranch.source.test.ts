/**
 * Source-structure tests for fresh-launch stale-branch abandonment.
 * These inspect the SessionManager source text to verify structural guarantees.
 * No module mocks — uses the real fs to read the source.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '..', 'session', 'SessionManager.ts'),
  'utf-8',
);

// completeStart block: from its declaration to wireSession
const completeStartIdx = source.indexOf('private async completeStart(');
const wireSessionIdx = source.indexOf('private wireSession(');
const completeStartBlock = source.slice(completeStartIdx, wireSessionIdx);

describe('SessionManager stale-branch abandonment — source structure', () => {
  it('imports getTerminalSessionsForTask from db/queries', () => {
    expect(source).toMatch(/getTerminalSessionsForTask/);
    expect(source).toMatch(
      /import[\s\S]*getTerminalSessionsForTask[\s\S]*from.*queries/,
    );
  });

  it('calls getTerminalSessionsForTask in completeStart', () => {
    expect(completeStartBlock).toMatch(
      /getTerminalSessionsForTask\s*\(\s*sessionTaskId\s*\)/,
    );
  });

  it('calls closePRWithComment with superseded message', () => {
    expect(completeStartBlock).toMatch(/closePRWithComment/);
    expect(completeStartBlock).toMatch(/Superseded.*fresh-start policy/);
  });

  it('deletes branch locally with git branch -D', () => {
    expect(completeStartBlock).toMatch(/git branch -D/);
  });

  it('deletes branch on origin via githubClient.deleteBranch', () => {
    expect(completeStartBlock).toMatch(/deleteBranch/);
    expect(completeStartBlock).toMatch(/githubRepo/);
  });

  it('emits stale_branch_abandoned audit event with priorSessionId', () => {
    expect(completeStartBlock).toMatch(/stale_branch_abandoned/);
    expect(completeStartBlock).toMatch(/priorSessionId/);
  });

  it('has two git worktree add -b calls (original attempt + retry)', () => {
    const matches = [...completeStartBlock.matchAll(/git worktree add -b/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('retry catch throws WorktreeSetupError with isBranchAlreadyExists: false', () => {
    expect(completeStartBlock).toMatch(
      /WorktreeSetupError[\s\S]{1,200}isBranchAlreadyExists:\s*false/,
    );
  });

  it('no-predecessor else branch throws WorktreeSetupError with isBranchAlreadyExists variable', () => {
    // The "else" path (no terminal predecessor) must preserve the original error
    expect(completeStartBlock).toMatch(
      /WorktreeSetupError[\s\S]{1,200}isBranchAlreadyExists\s*\}/,
    );
  });

  it('does not contain old reattach logic', () => {
    expect(completeStartBlock).not.toMatch(/Branch carries PR commits/);
    expect(completeStartBlock).not.toMatch(/reattach/i);
  });
});
