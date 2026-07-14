import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Grep-guard: the five route-based cutover clients (ops/groom/gate/seed +
// stage-task-intent) must agree on one host var name and one port var name
// (ORCHESTRATOR_BACKEND_HOST / ORCHESTRATOR_BACKEND_PORT). Token vars stay
// deliberately distinct — the four device-auth clients read
// ORCHESTRATOR_DEVICE_TOKEN, stage-task-intent.mjs reads the separate,
// lesser-privileged ORCHESTRATOR_STAGE_TOKEN — so this only asserts each
// client's token var is one of those two known names, not a single name.

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(backendRoot, '../..');

const DEVICE_AUTH_CLIENTS = [
  resolve(repoRoot, 'scripts/ops-client.mjs'),
  resolve(backendRoot, 'scripts/groom-context-client.mjs'),
  resolve(backendRoot, 'scripts/gate-state-client.mjs'),
  resolve(backendRoot, 'scripts/seed-state-client.mjs'),
];
const STAGE_TOKEN_CLIENT = resolve(
  backendRoot,
  'scripts/stage-task-intent.mjs',
);
const ALL_CLIENTS = [...DEVICE_AUTH_CLIENTS, STAGE_TOKEN_CLIENT];

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

  it('stage-task-intent.mjs reads the distinct, write-only ORCHESTRATOR_STAGE_TOKEN', () => {
    const source = readFileSync(STAGE_TOKEN_CLIENT, 'utf8');
    expect(source).toContain('process.env.ORCHESTRATOR_STAGE_TOKEN');
    expect(source).not.toContain('process.env.ORCHESTRATOR_DEVICE_TOKEN');
  });
});
