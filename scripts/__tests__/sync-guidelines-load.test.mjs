import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const script = join(repo, 'scripts', 'sync-guidelines-load.mjs');

function loadPlan() {
  const configDir = mkdtempSync(join(tmpdir(), 'sync-guidelines-cfg-'));
  const claudeHome = mkdtempSync(join(tmpdir(), 'sync-guidelines-home-'));
  const out = execFileSync(
    'node',
    [
      script,
      '--json',
      '--repo',
      repo,
      '--config-dir',
      configDir,
      '--claude-home',
      claudeHome,
    ],
    { encoding: 'utf8' },
  );
  return { configDir, plan: JSON.parse(out).plan };
}

describe('sync-guidelines-load vendor plan', () => {
  const { configDir, plan } = loadPlan();
  const byId = new Map(plan.map((i) => [i.id, i]));

  it('vendors the code-session-rules hook into <config>/hooks', () => {
    const item = byId.get('hook:inject-code-session-rules.mjs');
    assert.ok(item);
    assert.equal(
      item.upstreamPath,
      join(repo, 'config-template', 'hooks', 'inject-code-session-rules.mjs'),
    );
    assert.equal(
      item.livePath,
      join(configDir, 'hooks', 'inject-code-session-rules.mjs'),
    );
  });

  it('vendors code-session-rules.md into the config tree root', () => {
    const item = byId.get('code-session-rules.md');
    assert.ok(item);
    assert.equal(
      item.upstreamPath,
      join(repo, 'config-template', 'code-session-rules.md'),
    );
    assert.equal(item.livePath, join(configDir, 'code-session-rules.md'));
  });

  it('has a vendor item for every hook under config-template/hooks', () => {
    const hooks = readdirSync(join(repo, 'config-template', 'hooks'), {
      withFileTypes: true,
    })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => e.name);
    assert.ok(hooks.length > 0);
    for (const name of hooks) {
      assert.ok(byId.has(`hook:${name}`), `hook ${name} is not vendored`);
    }
  });
});
