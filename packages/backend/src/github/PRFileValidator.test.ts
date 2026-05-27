import { describe, it, expect } from 'vitest';
import {
  validatePRFiles,
  HARD_BANNED_FILES,
} from './PRFileValidator';

describe('HARD_BANNED_FILES', () => {
  it('contains CLAUDE.md, .commit-msg, .commit_msg', () => {
    expect(HARD_BANNED_FILES).toContain('CLAUDE.md');
    expect(HARD_BANNED_FILES).toContain('.commit-msg');
    expect(HARD_BANNED_FILES).toContain('.commit_msg');
  });
});

describe('validatePRFiles()', () => {
  it('accepts a PR diff with no banned files and no gitignored paths', () => {
    const result = validatePRFiles(
      ['src/index.ts', 'packages/backend/src/foo.ts'],
      [],
    );
    expect(result.valid).toBe(true);
    expect(result.bannedFiles).toHaveLength(0);
    expect(result.reason).toBeUndefined();
  });

  it('rejects CLAUDE.md (exact case)', () => {
    const result = validatePRFiles(['src/foo.ts', 'CLAUDE.md'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('CLAUDE.md');
    expect(result.reason).toBe('hard_banned');
  });

  it('rejects CLAUDE.MD (uppercase variant)', () => {
    const result = validatePRFiles(['CLAUDE.MD'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('CLAUDE.MD');
  });

  it('rejects claude.md (lowercase variant)', () => {
    const result = validatePRFiles(['claude.md'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('claude.md');
  });

  it('rejects .commit-msg', () => {
    const result = validatePRFiles(['.commit-msg'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('.commit-msg');
  });

  it('rejects .commit_msg', () => {
    const result = validatePRFiles(['.commit_msg'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('.commit_msg');
  });

  it('rejects .env via gitignore pattern', () => {
    const result = validatePRFiles(
      ['.env'],
      [{ dir: '', content: '.env\n' }],
    );
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('.env');
    expect(result.reason).toBe('gitignore_match');
  });

  it('rejects node_modules/foo via gitignore', () => {
    const result = validatePRFiles(
      ['node_modules/foo/index.js'],
      [{ dir: '', content: 'node_modules/\n' }],
    );
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('node_modules/foo/index.js');
  });

  it('rejects dist/bar.js via gitignore', () => {
    const result = validatePRFiles(
      ['dist/bar.js'],
      [{ dir: '', content: 'dist/\n' }],
    );
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('dist/bar.js');
  });

  it('handles nested .gitignores — pattern in packages/x only matches under packages/x', () => {
    const gitignoreSources = [
      { dir: '', content: '*.db\n' },
      { dir: 'packages/x', content: '*.log\n' },
    ];

    // packages/x/debug.log should be caught by packages/x/.gitignore
    const inner = validatePRFiles(['packages/x/debug.log'], gitignoreSources);
    expect(inner.valid).toBe(false);
    expect(inner.bannedFiles).toContain('packages/x/debug.log');

    // top-level debug.log should NOT be caught by packages/x/.gitignore
    const outer = validatePRFiles(['debug.log'], gitignoreSources);
    expect(outer.valid).toBe(true);

    // top-level foo.db caught by root .gitignore
    const root = validatePRFiles(['foo.db'], gitignoreSources);
    expect(root.valid).toBe(false);
  });

  it('nested .gitignore does not match paths outside its subtree', () => {
    const gitignoreSources = [{ dir: 'packages/x', content: 'build/\n' }];
    // path outside subtree — should not match
    const result = validatePRFiles(['build/output.js'], gitignoreSources);
    expect(result.valid).toBe(true);
  });

  it('returns reason=mixed when both hard-banned and gitignore-matched files are present', () => {
    const result = validatePRFiles(
      ['CLAUDE.md', '.env'],
      [{ dir: '', content: '.env\n' }],
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('mixed');
  });

  it('returns the full list of banned files when multiple are present', () => {
    const result = validatePRFiles(
      ['CLAUDE.md', '.commit-msg', 'packages/backend/dist/server.js'],
      [{ dir: '', content: 'packages/backend/dist/\n' }],
    );
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('CLAUDE.md');
    expect(result.bannedFiles).toContain('.commit-msg');
    expect(result.bannedFiles).toContain('packages/backend/dist/server.js');
    expect(result.bannedFiles).toHaveLength(3);
  });
});
