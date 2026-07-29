import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Grep-guard: the seven route-based cutover clients (ops/groom/design/gate/
// seed/staged-intents + read-session-record) must agree on one host var name and
// one port var name (ORCHESTRATOR_BACKEND_HOST / ORCHESTRATOR_BACKEND_PORT).
// Token vars stay deliberately distinct — the five device-auth clients read
// ORCHESTRATOR_DEVICE_TOKEN, the one remaining stage-token client
// (read-session-record — task-write staging + verdict delivery now go
// through the orchestrator MCP tool surface instead of a CLI client) reads
// the separate, lesser-privileged ORCHESTRATOR_STAGE_TOKEN — so this only
// asserts each client's token var is one of those two known names, not a
// single name.

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(backendRoot, '../..');

const DEVICE_AUTH_CLIENTS = [
  resolve(repoRoot, 'scripts/ops-client.mjs'),
  resolve(backendRoot, 'scripts/groom-context-client.mjs'),
  resolve(backendRoot, 'scripts/design-context-client.mjs'),
  resolve(backendRoot, 'scripts/gate-state-client.mjs'),
  resolve(backendRoot, 'scripts/seed-state-client.mjs'),
  resolve(backendRoot, 'scripts/staged-intents-client.mjs'),
];
const STAGE_TOKEN_CLIENTS = [
  resolve(backendRoot, 'scripts/read-session-record.mjs'),
];
const ALL_CLIENTS = [...DEVICE_AUTH_CLIENTS, ...STAGE_TOKEN_CLIENTS];

describe('route client env-var naming', () => {
  it('uses ORCHESTRATOR_BACKEND_HOST / ORCHESTRATOR_BACKEND_PORT in every client', () => {
    for (const path of ALL_CLIENTS) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} missing ORCHESTRATOR_BACKEND_HOST`).toContain(
        'ORCHESTRATOR_BACKEND_HOST',
      );
      expect(source, `${path} missing ORCHESTRATOR_BACKEND_PORT`).toContain(
        'ORCHESTRATOR_BACKEND_PORT',
      );
      expect(
        source,
        `${path} still references retired ORCHESTRATOR_STAGE_PORT`,
      ).not.toContain('ORCHESTRATOR_STAGE_PORT');
    }
  });

  it('device-authed clients read ORCHESTRATOR_DEVICE_TOKEN, never ORCHESTRATOR_STAGE_TOKEN', () => {
    for (const path of DEVICE_AUTH_CLIENTS) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} missing ORCHESTRATOR_DEVICE_TOKEN`).toContain(
        'ORCHESTRATOR_DEVICE_TOKEN',
      );
      expect(
        source,
        `${path} unexpectedly reads ORCHESTRATOR_STAGE_TOKEN`,
      ).not.toContain('ORCHESTRATOR_STAGE_TOKEN');
    }
  });

  it('stage-token clients read the distinct ORCHESTRATOR_STAGE_TOKEN, never the device token', () => {
    for (const path of STAGE_TOKEN_CLIENTS) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} missing ORCHESTRATOR_STAGE_TOKEN`).toContain(
        'process.env.ORCHESTRATOR_STAGE_TOKEN',
      );
      expect(
        source,
        `${path} unexpectedly reads ORCHESTRATOR_DEVICE_TOKEN`,
      ).not.toContain('process.env.ORCHESTRATOR_DEVICE_TOKEN');
    }
  });
});
