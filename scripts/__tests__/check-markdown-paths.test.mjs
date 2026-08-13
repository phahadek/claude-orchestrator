import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFile,
  isExcluded,
  buildDirPrefixes,
  filterMarkdownFiles,
  FILE_ALLOWLIST,
} from '../check-markdown-paths.mjs';

const TRACKED = new Set([
  'scripts/check-markdown-paths.mjs',
  'docs/design.md',
  'README.md',
]);
const DIR_PREFIXES = buildDirPrefixes([...TRACKED]);

describe('check-markdown-paths.mjs', () => {
  it('passes a path that resolves to a tracked file', () => {
    const content =
      'See [the script](scripts/check-markdown-paths.mjs) for details.';
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.deepEqual(failures, []);
  });

  it('fails a path that does not resolve to any tracked file', () => {
    const content =
      'See [a stale link](scripts/does-not-exist.mjs) for details.';
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].path, 'scripts/does-not-exist.mjs');
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

  it('suppresses a failure on a line carrying the path-check:ignore marker', () => {
    const content =
      'See [a stale link](scripts/does-not-exist.mjs) for details. <!-- path-check:ignore -->';
    const failures = checkFile(content, 'README.md', TRACKED, DIR_PREFIXES);
    assert.deepEqual(failures, []);
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
