import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir = '';

vi.mock('../config/dataDir.js', () => ({
  getDataDir: () => tmpDir,
}));

import {
  initLogger,
  _resetForTesting,
  _setMaxBytesForTesting,
} from '../logger.js';

describe('initLogger', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  });

  afterEach(() => {
    _resetForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the logs directory and orchestrator.log file', () => {
    initLogger();
    expect(fs.existsSync(path.join(tmpDir, 'logs', 'orchestrator.log'))).toBe(
      true,
    );
  });

  it('writes console.log output with INFO level and ISO timestamp', () => {
    initLogger();
    console.log('hello world');
    const contents = fs.readFileSync(
      path.join(tmpDir, 'logs', 'orchestrator.log'),
      'utf8',
    );
    expect(contents).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(contents).toMatch(/\[INFO\s*\] hello world/);
  });

  it('writes console.warn output with WARN level', () => {
    initLogger();
    console.warn('something suspicious');
    const contents = fs.readFileSync(
      path.join(tmpDir, 'logs', 'orchestrator.log'),
      'utf8',
    );
    expect(contents).toMatch(/\[WARN\s*\] something suspicious/);
  });

  it('writes console.error output with ERROR level', () => {
    initLogger();
    console.error('something broke');
    const contents = fs.readFileSync(
      path.join(tmpDir, 'logs', 'orchestrator.log'),
      'utf8',
    );
    expect(contents).toMatch(/\[ERROR\s*\] something broke/);
  });

  it('rotates the log file when the size threshold is exceeded', () => {
    _setMaxBytesForTesting(64); // tiny threshold; each log line is ~50-60 bytes
    initLogger();
    const logPath = path.join(tmpDir, 'logs', 'orchestrator.log');

    // Two writes of ~55 bytes each exceed the 64-byte threshold → rotation
    console.log('rotation-test-line-0');
    console.log('rotation-test-line-1');

    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.statSync(logPath).size).toBeLessThan(64);
  });

  it('keeps at most 5 rotated backup files', () => {
    _setMaxBytesForTesting(64); // rotate aggressively for fast testing
    initLogger();
    const logPath = path.join(tmpDir, 'logs', 'orchestrator.log');

    // Write enough to trigger 6+ rotations
    for (let i = 0; i < 50; i++) {
      console.log('max-rotation-test-line-' + i);
    }

    expect(fs.existsSync(`${logPath}.5`)).toBe(true);
    expect(fs.existsSync(`${logPath}.6`)).toBe(false);
  });
});
