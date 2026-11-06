import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dirname, '..', 'scoped-script-tests.mjs');

let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'scoped-script-tests-'));
  mkdirSync(join(root, 'scripts', '__tests__'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', '__tests__', 'dummy.test.mjs'),
    "import { it } from 'node:test';\nit('dummy passes', () => {});\n",
  );
});

after(() => rmSync(root, { recursive: true, force: true }));

function run(files) {
  return spawnSync('node', [SCRIPT, ...files], {
    cwd: root,
    encoding: 'utf8',
  });
}

const reportXml = () =>
  readFileSync(join(root, '.test-reports', 'scripts.xml'), 'utf8');

describe('scoped-script-tests.mjs declaration', () => {
  it('skip path writes a declaring report with zero claimed paths', () => {
    const res = run(['packages/backend/src/a.ts']);
    assert.equal(res.status, 0);
    const xml = reportXml();
    assert.match(xml, /name="orchestrator\.declares" value="1"/);
    assert.doesNotMatch(xml, /orchestrator\.claimed_path/);
  });

  it('run path claims scripts and hooks paths, keeps the suites', () => {
    const res = run([
      'scripts/foo.mjs',
      'config-template/hooks/bar.sh',
      'packages/backend/src/b.ts',
    ]);
    assert.equal(res.status, 0, res.stderr);
    const xml = reportXml();
    assert.match(xml, /name="orchestrator\.declares" value="1"/);
    assert.match(
      xml,
      /name="orchestrator\.claimed_path" value="scripts\/foo\.mjs"/,
    );
    assert.match(
      xml,
      /name="orchestrator\.claimed_path" value="config-template\/hooks\/bar\.sh"/,
    );
    assert.doesNotMatch(xml, /packages\/backend\/src\/b\.ts/);
    assert.match(xml, /dummy passes/);
  });
});
