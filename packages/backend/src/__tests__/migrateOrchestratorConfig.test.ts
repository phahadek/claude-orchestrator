import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
// @ts-expect-error — importing a sibling .mjs script (no ambient types)
import {
  translate,
  // @ts-expect-error — same as above
} from '../../../../scripts/migrate-orchestrator-config.mjs';

describe('migrate-orchestrator-config', () => {
  describe('translate()', () => {
    it('maps allowedTools → allowed_tools', () => {
      const result = translate({
        allowedTools: ['Bash(npm:*)', 'Bash(npx:*)'],
      });
      expect(result.allowed_tools).toEqual(['Bash(npm:*)', 'Bash(npx:*)']);
    });

    it('maps bashRules → bash_rules', () => {
      const result = translate({ bashRules: ['Use npm.'] });
      expect(result.bash_rules).toEqual(['Use npm.']);
    });

    it('maps bootstrapScript → bootstrap_script', () => {
      const result = translate({ bootstrapScript: './bootstrap.sh' });
      expect(result.bootstrap_script).toBe('./bootstrap.sh');
    });

    it('maps prGate.typeCheck → first entry in verify', () => {
      const result = translate({ prGate: { typeCheck: 'npx tsc --noEmit' } });
      expect(result.verify).toEqual(['npx tsc --noEmit']);
    });

    it('maps prGate.build → second entry in verify (after typeCheck)', () => {
      const result = translate({
        prGate: { typeCheck: 'npx tsc --noEmit', build: 'npm run build' },
      });
      expect(result.verify).toEqual(['npx tsc --noEmit', 'npm run build']);
    });

    it('maps prGate.build → first entry in verify when typeCheck is absent', () => {
      const result = translate({ prGate: { build: 'npm run build' } });
      expect(result.verify).toEqual(['npm run build']);
    });

    it('leaves verify empty when prGate is absent', () => {
      const result = translate({ allowedTools: ['Bash(npm:*)'] });
      expect(result.verify).toEqual([]);
    });

    it('leaves new fields (autofix, ci_check_name) empty', () => {
      const result = translate({
        allowedTools: ['Bash(npm:*)'],
        prGate: { typeCheck: 'npx tsc --noEmit' },
      });
      expect(result.autofix).toEqual([]);
      expect(result.ci_check_name).toEqual([]);
    });

    it('defaults all optional fields when input is empty', () => {
      expect(translate({})).toEqual({
        autofix: [],
        verify: [],
        ci_check_name: [],
        allowed_tools: [],
        bash_rules: [],
        bootstrap_script: '',
      });
    });

    it('translates a realistic dotnet project config end-to-end', () => {
      const result = translate({
        allowedTools: ['Bash(dotnet:*)'],
        prGate: { typeCheck: 'dotnet build', build: 'dotnet test' },
        bootstrapScript: './orchestrator-bootstrap.sh',
        bashRules: [
          'Use `dotnet` for builds and tests. Do not use `npm` or `npx`.',
        ],
      });
      expect(result).toEqual({
        autofix: [],
        verify: ['dotnet build', 'dotnet test'],
        ci_check_name: [],
        allowed_tools: ['Bash(dotnet:*)'],
        bash_rules: [
          'Use `dotnet` for builds and tests. Do not use `npm` or `npx`.',
        ],
        bootstrap_script: './orchestrator-bootstrap.sh',
      });
    });

    it('ignores non-array allowedTools (graceful on malformed input)', () => {
      const result = translate({ allowedTools: 'not-an-array' });
      expect(result.allowed_tools).toEqual([]);
    });

    it('ignores non-array bashRules (graceful on malformed input)', () => {
      const result = translate({ bashRules: { broken: true } });
      expect(result.bash_rules).toEqual([]);
    });

    it('ignores non-string bootstrapScript (graceful on malformed input)', () => {
      const result = translate({ bootstrapScript: 42 });
      expect(result.bootstrap_script).toBe('');
    });

    it('handles null input without throwing', () => {
      expect(translate(null)).toEqual({
        autofix: [],
        verify: [],
        ci_check_name: [],
        allowed_tools: [],
        bash_rules: [],
        bootstrap_script: '',
      });
    });

    it('handles undefined input without throwing', () => {
      expect(translate(undefined)).toEqual({
        autofix: [],
        verify: [],
        ci_check_name: [],
        allowed_tools: [],
        bash_rules: [],
        bootstrap_script: '',
      });
    });
  });

  describe('end-to-end script invocation (dry-run)', () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-config-'));
      dbPath = path.join(tmpDir, 'dashboard.db');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('dry-run writes nothing and deletes nothing', async () => {
      // Set up a fake project dir with .claude/orchestrator.json
      const projectDir = path.join(tmpDir, 'fake-project');
      fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
      const jsonPath = path.join(projectDir, '.claude', 'orchestrator.json');
      const yamlPath = path.join(projectDir, '.claude-orchestrator.yml');
      fs.writeFileSync(
        jsonPath,
        JSON.stringify({
          allowedTools: ['Bash(npm:*)'],
          prGate: { typeCheck: 'npx tsc --noEmit' },
        }),
      );

      // Create a minimal SQLite DB with this one project
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);
      db.exec(
        'CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, project_dir TEXT)',
      );
      db.prepare(
        'INSERT INTO projects (id, name, project_dir) VALUES (?, ?, ?)',
      ).run('test', 'Test Project', projectDir);
      db.close();

      // Invoke the script via child_process
      const { spawnSync } = await import('child_process');
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
      const result = spawnSync(
        'node',
        [
          path.join(repoRoot, 'scripts', 'migrate-orchestrator-config.mjs'),
          '--db',
          dbPath,
          '--dry-run',
        ],
        { encoding: 'utf-8' },
      );

      expect(result.status).toBe(0);
      expect(fs.existsSync(yamlPath)).toBe(false);
      expect(fs.existsSync(jsonPath)).toBe(true);
      expect(result.stdout).toContain('[DRY-RUN]');
      expect(result.stdout).toContain('WOULD MIGRATE Test Project');
    });
  });
});
