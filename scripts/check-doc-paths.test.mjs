import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFile,
  isExcluded,
  buildDirPrefixes,
  filterMarkdownFiles,
  FILE_ALLOWLIST,
} from './check-doc-paths.mjs';

const TRACKED = new Set([
  'scripts/check-doc-paths.mjs',
  'docs/design.md',
  'README.md',
  'config-template/README.md',
]);
const DIR_PREFIXES = buildDirPrefixes([...TRACKED]);

describe('check-doc-paths.mjs', () => {
  it('passes a path that resolves to a tracked file', () => {
    const content =
      'See [the script](scripts/check-doc-paths.mjs) for details.';
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.deepEqual(failures, []);
  });

  it('fails a genuinely non-existent path with its file and line number', () => {
    const content = [
      'The engine used to live at',
      '`packages/backend/src/permissions/PermissionEngine.ts`.',
    ].join('\n');
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].line, 2);
    assert.equal(
      failures[0].path,
      'packages/backend/src/permissions/PermissionEngine.ts',
    );
  });

  it('resolves a relative link against the referencing file directory', () => {
    const content = 'See [design](./design.md) for details.';
    const failures = checkFile(
      content,
      'docs/architecture.md',
      TRACKED,
      DIR_PREFIXES,
    );
    assert.deepEqual(failures, []);
  });

  for (const [label, candidate] of [
    ['.claude/', '.claude/some-session-state.json'],
    ['.env', 'packages/backend/.env'],
    ['dist/', 'packages/backend/dist/server.js'],
    ['config/', 'config/projects/example/grooming.json'],
  ]) {
    it(`excludes ${label} paths from failures even though they do not resolve`, () => {
      assert.equal(isExcluded(candidate), true);
      const content = `See \`${candidate}\` for details.`;
      const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
      assert.deepEqual(failures, []);
    });
  }

  it('does not report a config/… path referenced from a config-template/ doc', () => {
    const content =
      'Deploys to `config/projects/example/grooming.json` on the live host.';
    const failures = checkFile(
      content,
      'config-template/README.md',
      TRACKED,
      DIR_PREFIXES,
    );
    assert.deepEqual(failures, []);
  });

  it('does not report a deliberate historical mention marked path-check:ignore', () => {
    const content =
      'A previous script, `scripts/deploy-grooming.mjs`, did this and was removed. <!-- path-check:ignore -->';
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.deepEqual(failures, []);
  });

  it('would otherwise report the same historical mention without the marker', () => {
    const content =
      'A previous script, `scripts/deploy-grooming.mjs`, did this and was removed.';
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].path, 'scripts/deploy-grooming.mjs');
  });

  it('detects an unresolved path inside an inline code span', () => {
    const content = 'Run `scripts/does-not-exist.mjs` to see the report.';
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].path, 'scripts/does-not-exist.mjs');
  });

  it('detects an unresolved path inside a fenced code block', () => {
    const content = [
      'Copy the file:',
      '```bash',
      'cp scripts/does-not-exist.mjs /tmp/backup.mjs',
      '```',
    ].join('\n');
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].line, 3);
    assert.equal(failures[0].path, 'scripts/does-not-exist.mjs');
  });

  it('exempts an entire fenced code block via a marker on the preceding line', () => {
    const content = [
      'Example config:',
      '<!-- path-check:ignore -->',
      '```json',
      '{ "bootstrapScript": "scripts/bootstrap-worktree.sh" }',
      '```',
    ].join('\n');
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.deepEqual(failures, []);
  });

  it('suppresses a failure on a line carrying the path-check:ignore marker', () => {
    const content =
      'See [a stale link](scripts/does-not-exist.mjs) for details. <!-- path-check:ignore -->';
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.deepEqual(failures, []);
  });

  it('does not treat prose slashes outside known top-level entries as paths', () => {
    const content = 'Flip the read/write flag to on/off before you continue.';
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.deepEqual(failures, []);
  });

  it('reports the exit code as non-zero shaped output (file, line, path) for a real failure', () => {
    const content = 'Missing: `packages/does/not/exist.ts`';
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].line, 1);
    assert.equal(failures[0].path, 'packages/does/not/exist.ts');
  });

  it('skips a whole file via the FILE_ALLOWLIST', () => {
    FILE_ALLOWLIST.add('SKIPPED.md');
    try {
      const result = filterMarkdownFiles([
        'SKIPPED.md',
        'README.md',
        'notes.txt',
      ]);
      assert.deepEqual(result, ['README.md']);
    } finally {
      FILE_ALLOWLIST.delete('SKIPPED.md');
    }
  });
});
