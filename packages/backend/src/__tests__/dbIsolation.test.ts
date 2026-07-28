import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

describe('db.ts test-mode guard', () => {
  afterEach(() => {
    vi.doUnmock('../config/appConfig');
    vi.resetModules();
  });

  it('refuses to open a production-looking db path in test mode instead of silently opening it', async () => {
    const prodPath = path.join(
      os.tmpdir(),
      `fake-production-${process.pid}-${Math.floor(Math.random() * 1e9)}.db`,
    );
    if (fs.existsSync(prodPath)) fs.unlinkSync(prodPath);

    vi.resetModules();
    vi.doMock('../config/appConfig', () => ({
      getOrchestratorConfig: () => ({ db: { path: prodPath } }),
    }));

    await expect(import('../db/db')).rejects.toThrow(/Refusing to open/);
    // The guard must fire before `new Database(...)` — no file should exist.
    expect(fs.existsSync(prodPath)).toBe(false);
  });

  it('allows an in-memory database in test mode', async () => {
    vi.resetModules();
    vi.doMock('../config/appConfig', () => ({
      getOrchestratorConfig: () => ({ db: { path: ':memory:' } }),
    }));

    const mod = await import('../db/db');
    expect(mod.db).toBeDefined();
  });
});

describe('CliSessionRunner spawn environment', () => {
  function createMockProc() {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({
      write(_chunk: unknown, _enc: unknown, cb: () => void) {
        cb();
      },
    });
    const proc = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      kill: vi.fn(),
      pid: 4242,
      exitCode: null,
    });
    return proc;
  }

  let spawnMock: ReturnType<typeof vi.fn>;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = '/srv/orchestrator/data/dashboard.db';

    vi.resetModules();
    spawnMock = vi.fn(() => createMockProc());
    vi.doMock('child_process', () => ({
      spawn: spawnMock,
      execSync: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.doUnmock('child_process');
    vi.resetModules();
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
  });

  it('does not forward DB_PATH to the spawned session subprocess', async () => {
    const { CliSessionRunner } = await import('../session/CliSessionRunner');
    const runner = new CliSessionRunner('test-session-id');

    const runPromise = runner.run(
      'hello',
      undefined,
      {
        worktreePath: '/tmp/some-worktree',
        model: undefined,
        allowedTools: [],
      },
      () => {},
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , spawnOptions] = spawnMock.mock.calls[0];
    expect(spawnOptions.env.DB_PATH).toBeUndefined();

    const proc = spawnMock.mock.results[0].value;
    proc.stdout.push(null);
    proc.emit('exit', 0);
    await runPromise;
  }, 10_000);
});
