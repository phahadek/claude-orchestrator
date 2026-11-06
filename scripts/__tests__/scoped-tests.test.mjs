import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dirname, '..', 'scoped-tests.mjs');

let root;
let binDir;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'scoped-tests-'));
  mkdirSync(join(root, 'packages', 'backend'), { recursive: true });
  mkdirSync(join(root, 'packages', 'frontend'), { recursive: true });
  binDir = join(root, 'bin');
  mkdirSync(binDir);
  // Fake `npx vitest related ... --outputFile=<path>`: writes a vitest-shaped report.
  const fake = join(binDir, 'npx');
  writeFileSync(
    fake,
    '#!/bin/sh\nfor a in "$@"; do case "$a" in --outputFile=*) out="${a#--outputFile=}";; esac; done\n' +
      'mkdir -p "$(dirname "$out")"\n' +
      'printf \'<?xml version="1.0"?>\\n<testsuites name="vitest tests" tests="1"><testsuite name="s" tests="1"><testcase name="t" classname="c"/></testsuite></testsuites>\\n\' > "$out"\n',
  );
  chmodSync(fake, 0o755);
});

after(() => rmSync(root, { recursive: true, force: true }));

function run(pkg, files) {
  return spawnSync('node', [SCRIPT, pkg, ...files], {
    cwd: root,
    env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}` },
    encoding: 'utf8',
  });
}

describe('scoped-tests.mjs declaration', () => {
  it('skip path writes a declaring report with zero claimed paths', () => {
    const res = run('backend', ['skills/gate/SKILL.md']);
    assert.equal(res.status, 0);
    const xml = readFileSync(
      join(root, 'packages/backend/.test-reports/backend.xml'),
      'utf8',
    );
    assert.match(xml, /name="orchestrator\.declares" value="1"/);
    assert.doesNotMatch(xml, /orchestrator\.claimed_path/);
  });

  it('run path report carries the claimed paths and keeps the suites', () => {
    const res = run('frontend', [
      'packages/frontend/src/a.ts',
      'packages/backend/src/b.ts',
    ]);
    assert.equal(res.status, 0);
    const xml = readFileSync(
      join(root, 'packages/frontend/.test-reports/frontend.xml'),
      'utf8',
    );
    assert.match(xml, /name="orchestrator\.declares" value="1"/);
    assert.match(
      xml,
      /name="orchestrator\.claimed_path" value="packages\/frontend\/src\/a\.ts"/,
    );
    assert.doesNotMatch(xml, /packages\/backend\/src\/b\.ts/);
    assert.match(xml, /<testcase name="t"/);
  });
});
