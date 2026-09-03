import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  getOrchestratorConfig,
  _resetAppConfigCache,
  _setConfigSourceForTesting,
} from '../config/appConfig';
import { getDataDir } from '../config/dataDir';
import type {
  ConfigSource,
  DeepPartial,
  OrchestratorConfig,
} from '../config/types';

// This suite exercises the real testSetupDb.ts setupFile's installed
// default source (it runs before any test file, including this one) —
// no mocking of appConfig itself.
describe('test-mode config source isolation', () => {
  afterEach(() => {
    _resetAppConfigCache();
  });

  it('ignores a config.json in XDG_DATA_HOME with a non-:memory: db.path', () => {
    const dataDir = getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const configPath = path.join(dataDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ db: { path: '/tmp/should-never-be-read.db' } }),
    );

    try {
      _resetAppConfigCache();
      const config = getOrchestratorConfig();
      expect(config.db.path).toBe(':memory:');
    } finally {
      fs.rmSync(configPath, { force: true });
    }
  });

  it('keeps the in-memory test source in effect after _resetAppConfigCache()', () => {
    const dataDir = getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const configPath = path.join(dataDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ db: { path: '/tmp/leftover-from-a-prior-test.db' } }),
    );

    try {
      _resetAppConfigCache();
      const config = getOrchestratorConfig();
      expect(config.db.path).toBe(':memory:');
    } finally {
      fs.rmSync(configPath, { force: true });
    }
  });

  it('still allows a test to install its own source that overrides the default', () => {
    const customSource: ConfigSource = {
      read(): OrchestratorConfig {
        return {
          notion: { apiKey: 'custom-key' },
          github: { token: '', repo: '' },
          server: { port: 3000 },
          db: { path: ':memory:' },
          sessions: { dir: '' },
          autoReview: { enabled: true, concurrency: 1 },
          setupComplete: false,
        };
      },
      write(_partial: DeepPartial<OrchestratorConfig>): void {
        throw new Error('not implemented');
      },
    };

    _setConfigSourceForTesting(customSource);
    const config = getOrchestratorConfig();
    expect(config.notion.apiKey).toBe('custom-key');
  });
});
