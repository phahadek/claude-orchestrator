import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requestGroomFlip,
  buildFlipPayload,
} from '../../scripts/groom-flip-client.mjs';

let server: http.Server | undefined;
let tmpDir: string | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function startFixtureServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<number> {
  return new Promise((resolvePort) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolvePort((server!.address() as AddressInfo).port);
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

function writeGroomingState(state: Record<string, unknown>): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'groom-flip-client-test-'));
  const path = join(tmpDir, 'grooming-state.json');
  writeFileSync(path, JSON.stringify(state));
  return path;
}

const VALID_ENTRY = {
  title: 'Add the webhook',
  project: 'polimarket-analyser',
  milestone: 'M12',
  hard_block_deps: ['notion:dep-1'],
  size_check: { decision: 'no_split' },
  type_check: { decision: 'none' },
  gate_contribution: {
    classification: 'Read-Only',
    items: [{ text: 'Verify the webhook fires' }],
  },
  seed_contribution: {
    decision: 'seeds',
    seeds: [{ spec: 'Add webhook_url to config' }],
  },
};

describe('groom-flip-client.mjs — requestGroomFlip', () => {
  it('POSTs the payload to /api/groom/flip with the device bearer token', async () => {
    let receivedPath = '';
    let receivedAuth = '';
    let receivedBody = '';
    const port = await startFixtureServer(async (req, res) => {
      receivedPath = req.url ?? '';
      receivedAuth = req.headers['authorization'] ?? '';
      receivedBody = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const result = await requestGroomFlip({
      port,
      token: 'device-token-1',
      payload: { taskId: 'notion:abc' },
    });

    expect(result.statusCode).toBe(200);
    expect(receivedPath).toBe('/api/groom/flip');
    expect(receivedAuth).toBe('Bearer device-token-1');
    expect(JSON.parse(receivedBody)).toEqual({ taskId: 'notion:abc' });
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });
});

describe('groom-flip-client.mjs — buildFlipPayload', () => {
  it('resolves the whole flip request from the entry — no id is re-typed', () => {
    const path = writeGroomingState({ 'notion:abc': VALID_ENTRY });

    const payload = buildFlipPayload(path, 'notion:abc');

    expect(payload).toEqual({
      project: 'polimarket-analyser',
      taskId: 'notion:abc',
      title: 'Add the webhook',
      milestone: 'M12',
      dependsOn: ['notion:dep-1'],
      groomingGate: {
        size_check: { decision: 'no_split' },
        type_check: { decision: 'none' },
        type: undefined,
        regions: undefined,
        constraintsDispositioned: undefined,
        filesPathsEntries: undefined,
        dependsOnTasks: undefined,
        triage: undefined,
      },
      gateContribution: VALID_ENTRY.gate_contribution,
      seedContribution: VALID_ENTRY.seed_contribution,
    });
  });

  it('throws when the task has no entry in grooming-state.json', () => {
    const path = writeGroomingState({});

    expect(() => buildFlipPayload(path, 'notion:missing')).toThrow(
      /no entry for task "notion:missing"/,
    );
  });

  it('throws naming every missing required field', () => {
    const path = writeGroomingState({
      'notion:abc': { title: 'Add the webhook' },
    });

    expect(() => buildFlipPayload(path, 'notion:abc')).toThrow(
      /project, milestone, hard_block_deps, size_check, type_check, gate_contribution, seed_contribution/,
    );
  });
});
