import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
}));

// Capture every execSync command so we can assert on the docker network /
// proxy / session container invocations.
let capturedExecSyncCmds: string[] = [];

function makeMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: Object.assign(stdin, { writable: true, end: vi.fn() }),
    pid: 999,
    exitCode: null as number | null,
  });
  setImmediate(() => {
    stdout.push(null);
    proc.emit('exit', 0);
  });
  return proc;
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => makeMockProc()),
  execSync: vi.fn((cmd: string) => {
    capturedExecSyncCmds.push(cmd);
    return '';
  }),
}));

import { DockerSessionRunner } from '../DockerSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash'],
};

const DEFAULT_EGRESS_ALLOWLIST = [
  'api.anthropic.com',
  'api.github.com',
  'github.com',
  'api.notion.com',
];

beforeEach(() => {
  capturedExecSyncCmds = [];
  delete process.env.DOCKER_EGRESS_EXTRA_HOSTS;
  delete process.env.ANTHROPIC_API_KEY;
  vi.clearAllMocks();
});

describe('DockerSessionRunner egress isolation', () => {
  it('creates the session network with --internal', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const networkCmd = capturedExecSyncCmds.find((c) =>
      c.startsWith('docker network create'),
    );
    expect(networkCmd).toBeDefined();
    expect(networkCmd).toContain('--internal');
  });

  it('starts the session container on the internal network only, with no plain bridge/host networking', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const sessionRunCmd = capturedExecSyncCmds.find(
      (c) =>
        c.startsWith('docker run -d') &&
        c.includes(`--name claude-session-${SESSION_ID}`),
    );
    expect(sessionRunCmd).toBeDefined();
    expect(sessionRunCmd).toContain(`--network claude-session-net-${SESSION_ID}`);
    expect(sessionRunCmd).not.toContain('--network bridge');
    expect(sessionRunCmd).not.toContain('--network host');

    // Egress must be proxy-only: HTTPS_PROXY/HTTP_PROXY pointed at the proxy container.
    expect(sessionRunCmd).toContain(
      `-e HTTPS_PROXY=http://claude-session-proxy-${SESSION_ID}:3128`,
    );
    expect(sessionRunCmd).toContain(
      `-e HTTP_PROXY=http://claude-session-proxy-${SESSION_ID}:3128`,
    );

    // The proxy container is the only thing joined to bridge network as well.
    const bridgeConnectCmd = capturedExecSyncCmds.find((c) =>
      c.startsWith('docker network connect bridge'),
    );
    expect(bridgeConnectCmd).toBe(
      `docker network connect bridge claude-session-proxy-${SESSION_ID}`,
    );
  });

  it('excludes the Anthropic API key (and any raw API-key env var) from the session container run args', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-super-secret-value';
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    for (const cmd of capturedExecSyncCmds) {
      expect(cmd).not.toContain('ANTHROPIC_API_KEY');
      expect(cmd).not.toContain('sk-ant-super-secret-value');
      expect(cmd.toLowerCase()).not.toContain('api_key');
    }
  });

  it('builds the squid allowlist config from DEFAULT_EGRESS_ALLOWLIST with expected dstdomain entries', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const proxyRunCmd = capturedExecSyncCmds.find(
      (c) => c.startsWith('docker run -d') && c.includes('proxy'),
    );
    expect(proxyRunCmd).toBeDefined();

    for (const host of DEFAULT_EGRESS_ALLOWLIST) {
      expect(proxyRunCmd).toContain(`acl allowed_dst dstdomain .${host}`);
      expect(proxyRunCmd).toContain(host);
    }
    expect(proxyRunCmd).toContain('http_access allow allowed_dst');
    expect(proxyRunCmd).toContain('http_access deny all');
  });

  it('extends the allowlist with DOCKER_EGRESS_EXTRA_HOSTS when configured', async () => {
    process.env.DOCKER_EGRESS_EXTRA_HOSTS = 'extra.example.com, another.example.com';
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const proxyRunCmd = capturedExecSyncCmds.find(
      (c) => c.startsWith('docker run -d') && c.includes('proxy'),
    );
    expect(proxyRunCmd).toBeDefined();
    expect(proxyRunCmd).toContain('acl allowed_dst dstdomain .extra.example.com');
    expect(proxyRunCmd).toContain('acl allowed_dst dstdomain .another.example.com');
  });
});
