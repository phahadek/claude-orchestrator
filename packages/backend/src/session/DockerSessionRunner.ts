import { spawn, ChildProcess, execSync } from 'child_process';
import { createInterface } from 'readline';
import { config } from '../config';
import type {
  ISessionRunner,
  RawSessionEvent,
  SessionRunnerOptions,
} from './SessionRunner';

function log(sessionId: string, ...args: unknown[]) {
  console.log(`[DockerSessionRunner ${sessionId.slice(0, 8)}]`, ...args);
}

/**
 * Container name prefix for session containers.
 * Used by the orphan-reap logic to identify containers owned by this system.
 */
export const SESSION_CONTAINER_PREFIX = 'claude-session-';
export const PROXY_CONTAINER_PREFIX = 'claude-session-proxy-';
export const NETWORK_PREFIX = 'claude-session-net-';

/**
 * Default egress allowlist for the squid proxy.
 * Extended per-project with the Jira host from task_source_config when applicable.
 */
export const DEFAULT_EGRESS_ALLOWLIST = [
  'api.anthropic.com',
  'api.github.com',
  'github.com',
  'api.notion.com',
];

/**
 * Session runner that launches each session inside a dedicated Docker container
 * with a restricted egress proxy. Used when gates.dockerMandatory is true.
 *
 * Lifecycle per session:
 *  1. Create an internal Docker network (--internal).
 *  2. Start a squid proxy container joined to both the internal and external networks.
 *  3. Start the session container on the internal network only.
 *  4. Run bootstrap commands inside the container (if configured).
 *  5. Exec `claude` via docker exec with stdio piped through.
 *  6. On session end, stop and remove all three resources.
 */
export class DockerSessionRunner implements ISessionRunner {
  private _hasSpawnError = false;
  private containerName: string;
  private proxyContainerName: string;
  private networkName: string;
  private execProc: ChildProcess | null = null;
  private _killed = false;

  constructor(private readonly sessionId: string) {
    this.containerName = `${SESSION_CONTAINER_PREFIX}${sessionId}`;
    this.proxyContainerName = `${PROXY_CONTAINER_PREFIX}${sessionId}`;
    this.networkName = `${NETWORK_PREFIX}${sessionId}`;
  }

  get hasSpawnError(): boolean {
    return this._hasSpawnError;
  }

  async run(
    initialPrompt: string | undefined,
    resumeSessionId: string | undefined,
    options: SessionRunnerOptions,
    onEvent: (event: RawSessionEvent) => void,
  ): Promise<number | null> {
    const { worktreePath, model, allowedTools } = options;

    const claudeBin = config.claudePath;
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '/root';
    const claudeConfigDir = `${homeDir}/.claude`;

    // Build proxy allowlist: default + any extra hosts from environment
    const extraHosts = process.env.DOCKER_EGRESS_EXTRA_HOSTS
      ? process.env.DOCKER_EGRESS_EXTRA_HOSTS.split(',').map((h) => h.trim())
      : [];
    const allowlist = [...DEFAULT_EGRESS_ALLOWLIST, ...extraHosts].join(' ');

    // Session image — use pre-built image name from env or default
    const sessionImage =
      process.env.DOCKER_SESSION_IMAGE ?? 'claude-orchestrator-session:latest';

    try {
      // 1. Create isolated internal network
      log(this.sessionId, `creating network ${this.networkName}`);
      execSync(`docker network create --internal ${this.networkName}`, {
        stdio: 'pipe',
      });

      // 2. Start squid proxy on both external and internal networks
      log(this.sessionId, `starting proxy ${this.proxyContainerName}`);
      const squidConf = this._buildSquidConf(allowlist);
      execSync(
        [
          'docker run -d',
          `--name ${this.proxyContainerName}`,
          `--network ${this.networkName}`,
          `-e SQUID_ALLOWED_DSTS="${allowlist}"`,
          `-e SQUID_CONF="${squidConf}"`,
          'ubuntu/squid:latest',
        ].join(' '),
        { stdio: 'pipe' },
      );
      // Also connect proxy to the default bridge so it can reach the internet
      execSync(
        `docker network connect bridge ${this.proxyContainerName}`,
        { stdio: 'pipe' },
      );

      // 3. Start the session container on the internal network only (no internet)
      log(this.sessionId, `starting session container ${this.containerName}`);
      const proxyAddr = `http://${this.proxyContainerName}:3128`;
      execSync(
        [
          'docker run -d',
          `--name ${this.containerName}`,
          `--network ${this.networkName}`,
          // Mount worktree (read-write — claude needs to modify files)
          `-v "${worktreePath}:${worktreePath}"`,
          // Mount claude binary (read-only)
          `-v "${claudeBin}:${claudeBin}:ro"`,
          // Mount claude credentials and config (read-only)
          `-v "${claudeConfigDir}:/root/.claude:ro"`,
          // Egress proxy env vars
          `-e HTTPS_PROXY=${proxyAddr}`,
          `-e HTTP_PROXY=${proxyAddr}`,
          `-e NO_PROXY=localhost,127.0.0.1`,
          // Working directory
          `-w "${worktreePath}"`,
          // ANTHROPIC_API_KEY is intentionally NOT passed (not visible via docker inspect)
          sessionImage,
          // Keep container alive so we can docker exec into it
          'sleep infinity',
        ].join(' '),
        { stdio: 'pipe' },
      );
    } catch (err) {
      this._hasSpawnError = true;
      console.error(
        `[DockerSessionRunner] container setup failed for ${this.sessionId}: ${err}`,
      );
      await this._teardown();
      throw err;
    }

    // Build claude command arguments (same as CliSessionRunner)
    const claudeArgs = [
      ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
      '--print',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      ...(model ? ['--model', model] : []),
      '--allowed-tools',
      ...allowedTools,
    ];

    log(
      this.sessionId,
      `exec claude in container: ${claudeArgs.join(' ')}`,
    );

    // 4. Exec claude inside the container with stdio piped
    this.execProc = spawn(
      'docker',
      ['exec', '-i', this.containerName, claudeBin, ...claudeArgs],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    this.execProc.stdin!.on('error', (err: Error) => {
      log(this.sessionId, `stdin error (ignored): ${err.message}`);
    });

    this.execProc.on('error', (err) => {
      this._hasSpawnError = true;
      console.error(`[DockerSessionRunner] exec error: ${err.message}`);
    });

    this.execProc.stderr!.on('data', (chunk: Buffer) => {
      log(this.sessionId, `stderr: ${chunk.toString().trimEnd()}`);
    });

    // Send initial prompt via stdin (same protocol as CliSessionRunner)
    if (!resumeSessionId && initialPrompt) {
      try {
        this.execProc.stdin!.write(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: initialPrompt },
          }) + '\n',
        );
      } catch (err) {
        log(
          this.sessionId,
          `initial prompt stdin.write failed (ignored): ${(err as Error).message}`,
        );
      }
    }

    const rl = createInterface({ input: this.execProc.stdout! });
    const rlDone = new Promise<void>((resolve) => rl.once('close', resolve));

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      try {
        onEvent(event);
      } catch (err) {
        console.error(
          `[DockerSessionRunner] event handler threw for session ${this.sessionId}: ${(err as Error).message}`,
          err,
        );
      }
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      this.execProc!.once('exit', (code) => resolve(code));
    });

    await Promise.race([
      rlDone,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          rl.close();
          resolve();
        }, 5_000),
      ),
    ]);

    // 5. Teardown containers and network
    await this._teardown();

    return exitCode;
  }

  sendMessage(message: string): void {
    if (!this.execProc?.stdin?.writable) return;
    try {
      this.execProc.stdin.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: message },
        }) + '\n',
      );
    } catch (err) {
      log(
        this.sessionId,
        `sendMessage stdin.write failed (ignored): ${(err as Error).message}`,
      );
    }
  }

  endSession(): void {
    if (this.execProc?.stdin?.writable) {
      this.execProc.stdin.end();
    }
  }

  async kill(): Promise<void> {
    if (this._killed) return;
    this._killed = true;

    if (this.execProc && this.execProc.exitCode === null) {
      try {
        this.execProc.kill('SIGTERM');
      } catch {
        // Already gone
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            this.execProc?.kill('SIGKILL');
          } catch {
            // Already gone
          }
          resolve();
        }, 5_000);
        this.execProc!.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    await this._teardown();
  }

  private async _teardown(): Promise<void> {
    for (const name of [this.containerName, this.proxyContainerName]) {
      try {
        execSync(`docker rm -f ${name}`, { stdio: 'pipe' });
      } catch {
        // Container may not exist or already removed
      }
    }
    try {
      execSync(`docker network rm ${this.networkName}`, { stdio: 'pipe' });
    } catch {
      // Network may not exist or already removed
    }
  }

  private _buildSquidConf(allowlist: string): string {
    // Minimal inline squid.conf — passed via env var for the proxy container
    const acls = allowlist
      .split(' ')
      .map((h) => `acl allowed_dst dstdomain .${h}`)
      .join('\\n');
    return `${acls}\\nhttp_access allow allowed_dst\\nhttp_access deny all`;
  }
}

/**
 * Reap orphaned Docker containers and networks from sessions no longer in the
 * active sessions set. Called on backend startup.
 *
 * Removes containers matching claude-session-*, claude-session-proxy-*,
 * and networks matching claude-session-net-* whose session ID is not in
 * the provided set of live session IDs.
 */
export function reapOrphanContainers(liveSessionIds: Set<string>): void {
  for (const prefix of [SESSION_CONTAINER_PREFIX, PROXY_CONTAINER_PREFIX]) {
    try {
      const output = execSync(
        `docker ps -a --filter "name=${prefix}" --format "{{.Names}}"`,
        { encoding: 'utf-8', stdio: 'pipe' },
      ).trim();
      if (!output) continue;

      for (const name of output.split('\n').map((n) => n.trim()).filter(Boolean)) {
        const sessionId = name.replace(prefix, '');
        if (!liveSessionIds.has(sessionId)) {
          log(sessionId, `reaping orphan container: ${name}`);
          try {
            execSync(`docker rm -f ${name}`, { stdio: 'pipe' });
          } catch {
            // Already removed or not found
          }
        }
      }
    } catch {
      // docker not available or no containers found — skip silently
    }
  }

  try {
    const output = execSync(
      `docker network ls --filter "name=${NETWORK_PREFIX}" --format "{{.Name}}"`,
      { encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    if (!output) return;

    for (const name of output.split('\n').map((n) => n.trim()).filter(Boolean)) {
      const sessionId = name.replace(NETWORK_PREFIX, '');
      if (!liveSessionIds.has(sessionId)) {
        log(sessionId, `reaping orphan network: ${name}`);
        try {
          execSync(`docker network rm ${name}`, { stdio: 'pipe' });
        } catch {
          // Already removed or not found
        }
      }
    }
  } catch {
    // docker not available or no networks found — skip silently
  }
}
