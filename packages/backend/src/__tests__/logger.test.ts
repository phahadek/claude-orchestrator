import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  initLogger,
  _resetForTesting,
  _setMaxBytesForTesting,
} from '../logger.js';

// bootstrap.ts (a global Vitest setupFile, see vitest.config.ts) eagerly
// calls initLogger() once at setupFile-load time — before this file even
// starts loading. That first call binds logger.ts's internal `getDataDir`
// reference to the real (un-mocked) config/dataDir module, since Vitest's
// mock hoisting only reorders imports within a single file and can't
// retroactively rewire a module another, earlier-running setupFile already
// resolved. So `vi.mock('../config/dataDir.js', ...)` here would silently
// never take effect for logger.ts's own calls to getDataDir() — every
// initLogger() call in this suite would keep writing to the real data dir
// instead of a per-test tmp dir.
//
// Rather than fight that with vi.resetModules() (which also invalidates
// other setupFiles' one-time side effects, e.g. testSetupDb.ts's in-memory
// DB_PATH wiring, causing unrelated collection failures), this suite
// exercises the REAL getDataDir() and points it at a tmp dir the same way a
// real deployment would: by setting XDG_DATA_HOME (see config/dataDir.ts's
// non-win32/darwin branch: `process.env.XDG_DATA_HOME ?? ~/.local/share`),
// which getDataDir() reads fresh on every call — no caching/import-binding
// pitfall. Assertions check the resulting `<XDG_DATA_HOME>/claude-orchestrator`
// dir, exactly as production resolves it.
let tmpParent = '';
let dataDir = '';
let prevXdgDataHome: string | undefined;

describe('initLogger', () => {
  beforeEach(() => {
    // Undo bootstrap.ts's setupFile-time initLogger() call (and any prior
    // test's own initLogger() call) before this test wraps console again —
    // initLogger() is not reentrant: calling it while console.log is
    // already wrapped rebinds the wrapper's `_origLog` closure to itself,
    // causing infinite recursion on the next console.log call.
    _resetForTesting();
    tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    prevXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpParent;
    dataDir = path.join(tmpParent, 'claude-orchestrator');
  });

  afterEach(() => {
    _resetForTesting();
    if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgDataHome;
    fs.rmSync(tmpParent, { recursive: true, force: true });
  });

  it('creates the logs directory and orchestrator.log file', () => {
    initLogger();
    expect(fs.existsSync(path.join(dataDir, 'logs', 'orchestrator.log'))).toBe(
      true,
    );
  });

  it('writes console.log output with INFO level and ISO timestamp', () => {
    initLogger();
    console.log('hello world');
    const contents = fs.readFileSync(
      path.join(dataDir, 'logs', 'orchestrator.log'),
      'utf8',
    );
    expect(contents).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(contents).toMatch(/\[INFO\s*\] hello world/);
  });

  it('writes console.warn output with WARN level', () => {
    initLogger();
    console.warn('something suspicious');
    const contents = fs.readFileSync(
      path.join(dataDir, 'logs', 'orchestrator.log'),
      'utf8',
    );
    expect(contents).toMatch(/\[WARN\s*\] something suspicious/);
  });

  it('writes console.error output with ERROR level', () => {
    initLogger();
    console.error('something broke');
    const contents = fs.readFileSync(
      path.join(dataDir, 'logs', 'orchestrator.log'),
      'utf8',
    );
    expect(contents).toMatch(/\[ERROR\s*\] something broke/);
  });

  it('rotates the log file when the size threshold is exceeded', () => {
    _setMaxBytesForTesting(64); // tiny threshold; each log line is ~50-60 bytes
    initLogger();
    const logPath = path.join(dataDir, 'logs', 'orchestrator.log');

    // Two writes of ~55 bytes each exceed the 64-byte threshold → rotation
    console.log('rotation-test-line-0');
    console.log('rotation-test-line-1');

    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.statSync(logPath).size).toBeLessThan(64);
  });

  it('logs the Error message instead of serializing to {}', () => {
    initLogger();
    console.error(
      '[SessionManager] completeStart failed for abc123:',
      new Error('spawn failed: missing auth token'),
    );
    const contents = fs.readFileSync(
      path.join(dataDir, 'logs', 'orchestrator.log'),
      'utf8',
    );
    expect(contents).toContain('spawn failed: missing auth token');
    expect(contents).not.toContain('{}');
  });

  it('scrubs secrets from an unwrapped Error before writing', () => {
    initLogger();
    console.error(
      'boot failed:',
      new Error('auth step failed: Bearer sk-ant-abcdefghijklmnop'),
    );
    const contents = fs.readFileSync(
      path.join(dataDir, 'logs', 'orchestrator.log'),
      'utf8',
    );
    expect(contents).toContain('[REDACTED]');
    expect(contents).not.toContain('sk-ant-abcdefghijklmnop');
  });

  it('keeps at most 5 rotated backup files', () => {
    _setMaxBytesForTesting(64); // rotate aggressively for fast testing
    initLogger();
    const logPath = path.join(dataDir, 'logs', 'orchestrator.log');

    // Write enough to trigger 6+ rotations
    for (let i = 0; i < 50; i++) {
      console.log('max-rotation-test-line-' + i);
    }

    expect(fs.existsSync(`${logPath}.5`)).toBe(true);
    expect(fs.existsSync(`${logPath}.6`)).toBe(false);
  });
});
