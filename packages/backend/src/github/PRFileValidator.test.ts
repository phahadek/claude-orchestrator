import { describe, it, expect } from 'vitest';
import {
  validatePRFiles,
  isHardBanned,
  HARD_BANNED_FILES,
  HARD_BANNED_PATTERNS,
} from './PRFileValidator';

describe('isHardBanned()', () => {
  it('returns true for CLAUDE.md', () => {
    expect(isHardBanned('CLAUDE.md')).toBe(true);
  });

  it('returns true for CLAUDE.MD (uppercase extension)', () => {
    expect(isHardBanned('CLAUDE.MD')).toBe(true);
  });

  it('returns true for .commit-msg', () => {
    expect(isHardBanned('.commit-msg')).toBe(true);
  });

  it('returns true for commit-msg.draft (pattern match)', () => {
    expect(isHardBanned('commit-msg.draft')).toBe(true);
  });

  it('returns true for nested path containing CLAUDE.md', () => {
    expect(isHardBanned('some/subdir/CLAUDE.md')).toBe(true);
  });

  it('returns false for src/index.ts', () => {
    expect(isHardBanned('src/index.ts')).toBe(false);
  });

  it('returns false for README.md', () => {
    expect(isHardBanned('README.md')).toBe(false);
  });
});

describe('HARD_BANNED_FILES', () => {
  it('contains CLAUDE.md, .commit-msg, .commit_msg', () => {
    expect(HARD_BANNED_FILES).toContain('CLAUDE.md');
    expect(HARD_BANNED_FILES).toContain('.commit-msg');
    expect(HARD_BANNED_FILES).toContain('.commit_msg');
  });
});

describe('HARD_BANNED_PATTERNS', () => {
  it('matches commit-msg.txt', () => {
    expect(HARD_BANNED_PATTERNS.some((p) => p.test('commit-msg.txt'))).toBe(
      true,
    );
  });

  it('matches commit_msg.txt', () => {
    expect(HARD_BANNED_PATTERNS.some((p) => p.test('commit_msg.txt'))).toBe(
      true,
    );
  });

  it('matches commit-msg.draft', () => {
    expect(HARD_BANNED_PATTERNS.some((p) => p.test('commit-msg.draft'))).toBe(
      true,
    );
  });

  it('matches commit_msg.md', () => {
    expect(HARD_BANNED_PATTERNS.some((p) => p.test('commit_msg.md'))).toBe(
      true,
    );
  });

  it('does not match README.txt', () => {
    expect(HARD_BANNED_PATTERNS.some((p) => p.test('README.txt'))).toBe(false);
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

  it('rejects commit-msg.txt', () => {
    const result = validatePRFiles(['commit-msg.txt'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('commit-msg.txt');
    expect(result.reason).toBe('hard_banned');
  });

  it('rejects commit_msg.txt', () => {
    const result = validatePRFiles(['commit_msg.txt'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('commit_msg.txt');
    expect(result.reason).toBe('hard_banned');
  });

  it('rejects case-insensitive Commit-Msg.TXT', () => {
    const result = validatePRFiles(['Commit-Msg.TXT'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('Commit-Msg.TXT');
  });

  it('rejects case-insensitive COMMIT_MSG.txt', () => {
    const result = validatePRFiles(['COMMIT_MSG.txt'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('COMMIT_MSG.txt');
  });

  it('rejects commit-msg.draft (pattern match)', () => {
    const result = validatePRFiles(['commit-msg.draft'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('commit-msg.draft');
  });

  it('rejects commit_msg.md (pattern match)', () => {
    const result = validatePRFiles(['commit_msg.md'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('commit_msg.md');
  });

  it('accepts non-scratch .txt files', () => {
    const result = validatePRFiles(['README.txt', 'docs/notes.txt'], []);
    expect(result.valid).toBe(true);
    expect(result.bannedFiles).toHaveLength(0);
  });

  it('rejects commit-msg.txt nested in a subdirectory', () => {
    const result = validatePRFiles(['some/nested/commit-msg.txt'], []);
    expect(result.valid).toBe(false);
    expect(result.bannedFiles).toContain('some/nested/commit-msg.txt');
  });

  it('rejects .env via gitignore pattern', () => {
    const result = validatePRFiles(['.env'], [{ dir: '', content: '.env\n' }]);
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
