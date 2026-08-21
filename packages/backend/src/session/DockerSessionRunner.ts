import { spawn, ChildProcess, execSync } from 'child_process';
import { createInterface } from 'readline';
import {
  config,
  PLANNING_DISALLOWED_TOOLS,
  SCHEDULING_DISALLOWED_TOOLS,
} from '../config';
import type {
  ISessionRunner,
  RawSessionEvent,
  SessionRunnerOptions,
} from './SessionRunner';
import { logger } from '../logger';
import { isPlanningSession, isCodeSession } from './sessionPredicates';
import {
  getSessionAddDirs,
  getTestCommandDenyPatterns,
  loadOrchestratorConfig,
} from './orchestrator-config';
import { createScratchDir, removeScratchDir } from './planningScratchDir';

function log(sessionId: string, ...args: unknown[]) {
  logger.info(`[DockerSessionRunner ${sessionId.slice(0, 8)}]`, ...args);
}

/**
 * How long endSession() waits for the exec process to exit on its own
 * after stdin close before escalating to a forceful kill() + container
 * teardown.
 */
const GRACEFUL_END_TIMEOUT_MS = 15_000;

/**
 * Container name prefix for session containers.
 * Used by the orphan-reap logic to identify containers owned by this system.
 */
const SESSION_CONTAINER_PREFIX = 'claude-session-';
const PROXY_CONTAINER_PREFIX = 'claude-session-proxy-';
const NETWORK_PREFIX = 'claude-session-net-';

/**
 * Default egress allowlist for the squid proxy.
 * Extended per-project with the Jira host from task_source_config when applicable.
 */
const DEFAULT_EGRESS_ALLOWLIST = [
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
  private _paused = false;
  private _isPlanning = false;
  private _scratchDir: string | undefined;

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
    const {
      worktreePath,
      model,
      allowedTools,
      mcpConfigPath,
      systemPromptFilePath,
      sessionType,
      granted,
    } = options;
    const isPlanning = Boolean(sessionType && isPlanningSession(sessionType));
    this._isPlanning = isPlanning;

    // Per-session-type filesystem read envelope baseline plus any granted
    // `read:path:` capability — see orchestrator-config.ts#getSessionAddDirs.
    // `--add-dir` inside the container only reaches paths already bind-
    // mounted into it, so each entry here must also be added as a read-only
    // `-v <path>:<path>:ro` mount on the `docker run` invocation below, not
    // just appended to the `claude` exec's `--add-dir` list.
    const addDirs = getSessionAddDirs(
      sessionType ?? '',
      granted ?? [],
      worktreePath,
    );

    // Planning sessions share `cwd` === the project checkout (worktreePath
    // here) across concurrent sessions. Give them a writable per-session
    // scratch dir for output that shouldn't land in tracked files — the
    // checkout mount below stays read-write for planning and coding
    // sessions alike.
    if (isPlanning) {
      this._scratchDir = createScratchDir(worktreePath, this.sessionId);
    }

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
      execSync(`docker network connect bridge ${this.proxyContainerName}`, {
        stdio: 'pipe',
      });

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
          // Per-type read envelope baseline + granted read:path: roots
          // (read-only) — matches the --add-dir list on the claude exec below.
          ...addDirs.map((dir) => `-v "${dir}:${dir}:ro"`),
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
      logger.error(
        `[DockerSessionRunner] container setup failed for ${this.sessionId}: ${err}`,
      );
      await this._teardown();
      throw err;
    }

    // Build claude command arguments (same as CliSessionRunner)
    const permissionMode = isPlanning ? 'default' : 'acceptEdits';

    // Code sessions must not be able to run the project's test commands
    // directly — they're denied at the SDK permission layer (via the CLI's
    // --settings flag, the settings.json-based route to the same
    // `permissions.deny` field the Agent SDK exposes) and routed through
    // test.request instead (see the Flaky/CI section of orchestrator-claudemd.ts).
    const testDenyPatterns =
      sessionType && isCodeSession(sessionType)
        ? getTestCommandDenyPatterns(loadOrchestratorConfig(worktreePath).test)
        : [];

    const claudeArgs = [
      ...(resumeSessionId
        ? ['--resume', resumeSessionId]
        : ['--session-id', this.sessionId]),
      '--print',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      permissionMode,
      ...(model ? ['--model', model] : []),
      ...(testDenyPatterns.length
        ? [
            '--settings',
            JSON.stringify({ permissions: { deny: testDenyPatterns } }),
          ]
        : []),
      ...(mcpConfigPath
        ? ['--mcp-config', mcpConfigPath, '--strict-mcp-config']
        : []),
      ...(systemPromptFilePath
        ? ['--append-system-prompt-file', systemPromptFilePath]
        : []),
      '--allowed-tools',
      ...allowedTools,
      '--disallowed-tools',
      ...(isPlanning
        ? PLANNING_DISALLOWED_TOOLS
        : SCHEDULING_DISALLOWED_TOOLS),
      ...addDirs.flatMap((dir) => ['--add-dir', dir]),
    ];

    log(this.sessionId, `exec claude in container: ${claudeArgs.join(' ')}`);

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
      logger.error(`[DockerSessionRunner] exec error: ${err.message}`);
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
        logger.error(
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

  sendMessage(message: string): boolean {
    if (!this.execProc?.stdin?.writable) return false;
    try {
      this.execProc.stdin.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: message },
        }) + '\n',
      );
      return true;
    } catch (err) {
      log(
        this.sessionId,
        `sendMessage stdin.write failed: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * @returns true if the exec process did not exit on its own within the
   * grace period and had to be escalated to a forceful kill() — callers use
   * this to decide whether the escalation is audit-worthy.
   */
  async endSession(): Promise<boolean> {
    if (this.execProc?.stdin?.writable) {
      this.execProc.stdin.end();
    }
    return this.waitForExitOrEscalate();
  }

  /**
   * Waits up to GRACEFUL_END_TIMEOUT_MS for the exec process to exit on its
   * own after stdin close. If it does not, escalates to kill() (SIGTERM,
   * then SIGKILL, then container/network teardown) — a container surviving
   * its session is exactly the kind of leak this is meant to catch.
   */
  private async waitForExitOrEscalate(): Promise<boolean> {
    if (!this.execProc || this.execProc.exitCode !== null) return false;
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), GRACEFUL_END_TIMEOUT_MS);
      this.execProc!.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (exited) return false;
    log(
      this.sessionId,
      `did not exit within ${GRACEFUL_END_TIMEOUT_MS}ms of stdin close; escalating to kill()`,
    );
    await this.kill();
    return true;
  }

  async kill(): Promise<void> {
    if (this._killed) return;
    this._killed = true;
    await this._killExecProc();
    await this._teardown();
  }

  /**
   * Pause for a graceful backend restart: stop the `docker exec` process
   * driving the session but deliberately skip `_teardown()` — the session
   * container, proxy container, and network must survive so
   * `resumeOrphanSessions` can `docker exec` back into the same container
   * on next boot instead of every restart destroying live work.
   */
  async pause(): Promise<void> {
    if (this._killed || this._paused) return;
    this._paused = true;
    await this._killExecProc();
  }

  private async _killExecProc(): Promise<void> {
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
  }

  private async _teardown(): Promise<void> {
    if (this._isPlanning && this._scratchDir) {
      removeScratchDir(this._scratchDir);
    }
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

      for (const name of output
        .split('\n')
        .map((n) => n.trim())
        .filter(Boolean)) {
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

    for (const name of output
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean)) {
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
