/**
 * Tests for loadDeployBindings (packages/backend/src/deploy/loadDeployBindings.ts).
 *
 * AC: resolves its config-tree path via resolveConfigDir(projectDir) +
 * basename(projectDir), never a registry project id; an absent file (or
 * unresolvable config tree) yields an empty binding map; a malformed
 * present file fails closed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadDeployBindings } from '../loadDeployBindings';

describe('loadDeployBindings', () => {
  let tmpRoot: string;
  let projectDir: string;
  let configDir: string;
  let originalConfigDirEnv: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-bindings-'));
    projectDir = path.join(tmpRoot, 'checkout', 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });
    configDir = path.join(tmpRoot, 'config');
    fs.mkdirSync(path.join(configDir, 'projects', 'my-project'), {
      recursive: true,
    });
    originalConfigDirEnv = process.env.ORCHESTRATOR_CONFIG_DIR;
    process.env.ORCHESTRATOR_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalConfigDirEnv === undefined) {
      delete process.env.ORCHESTRATOR_CONFIG_DIR;
    } else {
      process.env.ORCHESTRATOR_CONFIG_DIR = originalConfigDirEnv;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('yields an empty binding map when deploy-bindings.yml is absent, but reports the path checked', () => {
    const result = loadDeployBindings(projectDir);
    const expectedPath = path.join(
      configDir,
      'projects',
      'my-project',
      'deploy-bindings.yml',
    );
    expect(result).toEqual({
      ok: true,
      bindings: {},
      bindingsPath: expectedPath,
    });
  });

  it('yields an empty binding map and a null path when the config tree cannot be resolved', () => {
    delete process.env.ORCHESTRATOR_CONFIG_DIR;
    // Isolated from `tmpRoot` (which has a sibling `config/` dir two levels
    // up from a project dir there) so `resolveConfigDir`'s relative-path
    // fallback checks genuinely find nothing.
    const isolatedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'deploy-bindings-isolated-'),
    );
    const unresolvable = path.join(isolatedRoot, 'checkout', 'some-project');
    fs.mkdirSync(unresolvable, { recursive: true });
    try {
      const result = loadDeployBindings(unresolvable);
      expect(result).toEqual({ ok: true, bindings: {}, bindingsPath: null });
    } finally {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('parses a valid deploy-bindings.yml keyed by basename(projectDir), not a registry id', () => {
    fs.writeFileSync(
      path.join(configDir, 'projects', 'my-project', 'deploy-bindings.yml'),
      'DB_HOST: db.internal\nDB_PORT: "5432"\n',
    );

    const result = loadDeployBindings(projectDir);
    expect(result).toEqual({
      ok: true,
      bindings: { DB_HOST: 'db.internal', DB_PORT: '5432' },
      bindingsPath: path.join(
        configDir,
        'projects',
        'my-project',
        'deploy-bindings.yml',
      ),
    });
  });

  it('fails closed on a malformed deploy-bindings.yml (invalid binding name)', () => {
    fs.writeFileSync(
      path.join(configDir, 'projects', 'my-project', 'deploy-bindings.yml'),
      '"not-a-valid-name": foo\n',
    );

    const result = loadDeployBindings(projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid deploy bindings/);
    }
  });

  it('fails closed on a malformed deploy-bindings.yml (non-string value)', () => {
    fs.writeFileSync(
      path.join(configDir, 'projects', 'my-project', 'deploy-bindings.yml'),
      'PORT: 5432\n',
    );

    const result = loadDeployBindings(projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/must be a string value/);
    }
  });

  it('fails closed when the YAML fails to parse', () => {
    fs.writeFileSync(
      path.join(configDir, 'projects', 'my-project', 'deploy-bindings.yml'),
      'DB_HOST: [\n',
    );

    const result = loadDeployBindings(projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/failed to parse/);
    }
  });
});
