import { spawn, ChildProcess, execSync } from 'child_process';
import { createInterface } from 'readline';
import {
  config,
  BASH_MAX_OUTPUT_LENGTH,
  BASH_DEFAULT_TIMEOUT_MS,
  PLANNING_DISALLOWED_TOOLS,
} from '../config';
import type {
  ISessionRunner,
  RawSessionEvent,
  SessionRunnerOptions,
} from './SessionRunner';
import { logger } from '../logger';
import {
  placeSessionPid,
  killSessionCgroup,
  spawnIntoSessionCgroup,
} from './sessionCgroup';
import { isPlanningSession, isCodeSession } from './sessionPredicates';
import {
  getSessionAddDirs,
  getTestCommandDenyPatterns,
  loadOrchestratorConfig,
} from './orchestrator-config';
import {
  createScratchDir,
  removeScratchDir,
  getScratchDir,
} from './planningScratchDir';

/**
 * How long endSession() waits for the process to exit on its own after
 * stdin close before escalating to a forceful process-tree kill().
 */
export const GRACEFUL_END_TIMEOUT_MS = 15_000;

function log(sessionId: string, ...args: unknown[]) {
  logger.info(`[CliSessionRunner ${sessionId.slice(0, 8)}]`, ...args);
}

/**
 * Session runner that spawns the `claude` CLI as a subprocess and communicates
 * via stdin/stdout using the stream-json protocol.
 *
 * This is the original transport and the default when SESSION_MODE is 'cli'.
 */
export class CliSessionRunner implements ISessionRunner {
  private proc: ChildProcess | null = null;
  private _hasSpawnError = false;

  constructor(private readonly sessionId: string) {}

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
      effort,
      allowedTools,
      mcpConfigPath,
      systemPromptFilePath,
      disableAutoCompact,
      extraEnv,
      sessionType,
      granted,
    } = options;

    // Planning/ops sessions must never silently auto-accept a tool call
    // outside their allowlist — a write/capability escalation needs to hit a
    // real permission denial so it can route through grant-on-re-dispatch.
    // Code/review sessions keep the existing acceptEdits behavior.
    const permissionMode =
      sessionType && isPlanningSession(sessionType) ? 'default' : 'acceptEdits';

    // Dispatched planning sessions run entirely from their injected
    // procedure — the interactive /groom, /design, and /ops skills must
    // never be reachable from one. The built-in Skill tool is NOT denied by
    // --allowed-tools omission (the CLI resolves skills via /skill-name
    // regardless of the allowlist), so it must be explicitly disallowed.
    // Write/Edit are disallowed here too (not just omitted from the
    // allowlist) so a denial can never be resolved by an operator granting
    // the capability on re-dispatch — see GRANT_DENYLIST_PATTERNS.
    const isPlanning = Boolean(sessionType && isPlanningSession(sessionType));

    // Planning sessions share `cwd` === the project checkout across
    // concurrent sessions (no worktree of their own — see below).
    // `worktreePath` is the project dir for planning sessions; give it a
    // writable per-session scratch dir for output that shouldn't land in
    // tracked files. The checkout itself is left read-write — see
    // SessionManager's post-session drift-detection audit event.
    if (isPlanning) {
      createScratchDir(worktreePath, this.sessionId);
    }

    // Planning/ops/gate-verify sessions have no worktree of their own (they
    // run with cwd === projectDir) and, per the settled design, are not
    // meant to be filesystem-jailed to the project checkout: the gate read
    // model needs host/DB/audit-log reach, and the ops write model needs to
    // execute granted commands against out-of-tree host paths. The
    // capability-grant allowlist (--allowed-tools) plus the Write/Edit/Skill
    // denylist above are the write-safety boundary for these session
    // types — not the CLI's directory sandbox. Rather than lifting the
    // sandbox wholesale (`--add-dir /` gave every dispatched planning
    // session direct OS-level read access to every other colocated
    // project's secrets and to other sessions' scoped `.mcp.json`
    // credential files, since all sessions run as one OS user), the
    // envelope is a small per-session-type baseline plus any
    // `read:path:` capability granted on re-dispatch — see
    // getSessionAddDirs. Coding/review sessions keep the default
    // worktree-only sandbox (empty add-dir list).
    const addDirs = getSessionAddDirs(
      sessionType ?? '',
      granted ?? [],
      worktreePath,
    );

    // Code sessions must not be able to run the project's test commands
    // directly — they're denied at the SDK permission layer (via the CLI's
    // --settings flag, the settings.json-based route to the same
    // `permissions.deny` field the Agent SDK exposes) and routed through
    // test.request instead (see the Flaky/CI section of orchestrator-claudemd.ts).
    const testDenyPatterns =
      sessionType && isCodeSession(sessionType)
        ? getTestCommandDenyPatterns(loadOrchestratorConfig(worktreePath).test)
        : [];
    const settingsOverrides: Record<string, unknown> = {};
    if (disableAutoCompact) settingsOverrides.autoCompactEnabled = false;
    if (testDenyPatterns.length) {
      settingsOverrides.permissions = { deny: testDenyPatterns };
    }

    const spawnArgs = [
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
      ...(effort ? ['--effort', effort] : []),
      ...(Object.keys(settingsOverrides).length
        ? ['--settings', JSON.stringify(settingsOverrides)]
        : []),
      ...(mcpConfigPath
        ? ['--mcp-config', mcpConfigPath, '--strict-mcp-config']
        : []),
      ...(systemPromptFilePath
        ? ['--append-system-prompt-file', systemPromptFilePath]
        : []),
      '--allowed-tools',
      ...allowedTools,
      ...(isPlanning
        ? ['--disallowed-tools', ...PLANNING_DISALLOWED_TOOLS]
        : []),
      ...addDirs.flatMap((dir) => ['--add-dir', dir]),
    ];

    const envKeys = ['PROJECT_DIR', 'SESSIONS_DIR'] as const;
    const envStr = envKeys
      .filter((k) => process.env[k] !== undefined)
      .map((k) => `${k}=${process.env[k]}`)
      .join(', ');
    log(
      this.sessionId,
      `spawning: cwd=${worktreePath} cmd=${config.claudePath} ${spawnArgs.join(' ')} env={${envStr}}`,
    );

    // Strip production data-plane env vars before they reach the child. A
    // session runs arbitrary code (including test suites) inside a worktree;
    // DB_PATH pointing at the live orchestrator database must never be
    // forwarded, or a `vitest run` inside the session would open and write
    // to production data. Session code has no legitimate need for this var.
    //
    // ORCHESTRATOR_DEVICE_TOKEN is stripped for a different reason: it's the
    // shared, human-operator credential the sanctioned route-client scripts
    // (gate-state-client.mjs, staged-intents-client.mjs, etc.) read when run
    // from an interactive Remote-Control session. Handing it to a dispatched
    // session would authorize everything those routes allow, forever, for
    // every device — the wrong shape for a scoped, revocable grant. A
    // dispatched session instead gets its own per-session, capability-scoped
    // credential via ORCHESTRATOR_ROUTE_CREDENTIAL_FILE (see extraEnv below
    // and SessionRouteAuth.ts). This backend process has no legitimate need
    // to hold ORCHESTRATOR_DEVICE_TOKEN in its own env either — device
    // tokens are validated against the DB, not an env var — so stripping it
    // here is a no-op for any expected deployment and pure defense-in-depth
    // against a misconfigured environment forwarding it.
    const {
      DB_PATH: _productionDbPath,
      ORCHESTRATOR_DEVICE_TOKEN: _sharedDeviceToken,
      ...inheritedEnv
    } = process.env;

    // Spawned with the backend temporarily relocated into this session's
    // cgroup (see spawnIntoSessionCgroup) so the child — and anything it
    // forks before the placeSessionPid backstop below runs — is born
    // directly into sessions/<sessionId>/ rather than briefly landing in
    // main/ and staying there for life (a daemonizing grandchild, e.g. a
    // temp postgres cluster's postmaster, never gets migrated later).
    this.proc = spawnIntoSessionCgroup(this.sessionId, () =>
      spawn(config.claudePath, spawnArgs, {
        cwd: worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...inheritedEnv,
          BASH_MAX_OUTPUT_LENGTH: String(BASH_MAX_OUTPUT_LENGTH),
          BASH_DEFAULT_TIMEOUT_MS: String(BASH_DEFAULT_TIMEOUT_MS),
          ...extraEnv,
        },
        ...(process.platform !== 'win32' && { detached: true }),
      }),
    );

    // Belt-and-suspenders: idempotent when spawnIntoSessionCgroup already
    // placed the pid correctly; a real backstop when it no-opped (e.g. the
    // relocation write failed but the spawn itself still succeeded).
    if (this.proc.pid) {
      placeSessionPid(this.proc.pid, this.sessionId);
    }

    // Async stdin errors (e.g. EPIPE when the child exits) must not bubble up
    // as unhandled 'error' events on the process.
    this.proc.stdin!.on('error', (err: Error) => {
      log(this.sessionId, `stdin error (ignored): ${err.message}`);
    });

    // Send initial prompt via stdin (required by --input-format stream-json).
    // Resumed sessions skip the initial prompt — the caller delivers via sendMessage().
    if (!resumeSessionId && initialPrompt) {
      try {
        this.proc.stdin!.write(
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

    this.proc.on('error', (err) => {
      this._hasSpawnError = true;
      logger.error(`[CliSessionRunner] spawn error: ${err.message}`);
    });

    // Pipe stderr to console for diagnostics
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      log(this.sessionId, `stderr: ${chunk.toString().trimEnd()}`);
    });

    const rl = createInterface({ input: this.proc.stdout! });

    // Capture readline completion early so we can drain after exit.
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
          `[CliSessionRunner] event handler threw for session ${this.sessionId}: ${(err as Error).message}`,
          err,
        );
      }
    });

    // Wait for the subprocess to exit.
    const exitCode = await new Promise<number | null>((resolve) => {
      this.proc!.once('exit', (code) => resolve(code));
    });

    // Drain remaining buffered lines (5s guard).
    await Promise.race([
      rlDone,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          rl.close();
          resolve();
        }, 5_000),
      ),
    ]);

    if (isPlanning) {
      removeScratchDir(getScratchDir(worktreePath, this.sessionId));
    }

    return exitCode;
  }

  sendMessage(message: string): boolean {
    if (!this.proc?.stdin?.writable) return false;
    try {
      this.proc.stdin.write(
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
   * @param concludedCleanly whether the caller is closing stdin as the
   * sanctioned conclusion of a session that already recorded why it's
   * ending (e.g. a groom session's markTerminal, after
   * setSessionTerminalCompletionReason) rather than an unexplained
   * teardown. Purely descriptive here (logging only) — AgentSession.endSession
   * is what actually carries this into the exit-code classification, since
   * it owns the DB/audit side this runner stays free of.
   * @returns true if the process did not exit on its own within the grace
   * period and had to be escalated to a forceful kill() — callers use this
   * to decide whether the escalation is audit-worthy.
   */
  async endSession(concludedCleanly = false): Promise<boolean> {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.end();
    }
    const escalated = await this.waitForExitOrEscalate(concludedCleanly);
    // Backstop, always run regardless of how the CLI process itself exited:
    // a daemonized grandchild (setsid()) can outlive this.proc — and thus
    // outlive the process-group kill above — even when this.proc exited
    // cleanly on its own and waitForExitOrEscalate never called kill().
    killSessionCgroup(this.sessionId);
    return escalated;
  }

  /**
   * Waits up to GRACEFUL_END_TIMEOUT_MS for the process to exit on its own
   * after stdin close. A CLI that does not honor stdin EOF (or a hung
   * subprocess) would otherwise sit alive forever under a session already
   * marked terminal — escalate to the same SIGTERM/SIGKILL process-tree
   * kill() used for explicit aborts.
   */
  private async waitForExitOrEscalate(
    concludedCleanly: boolean,
  ): Promise<boolean> {
    if (!this.proc || this.proc.exitCode !== null) return false;
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), GRACEFUL_END_TIMEOUT_MS);
      this.proc!.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (exited) return false;
    log(
      this.sessionId,
      `did not exit within ${GRACEFUL_END_TIMEOUT_MS}ms of stdin close` +
        (concludedCleanly ? ' (session already concluded cleanly)' : '') +
        '; escalating to kill()',
    );
    await this.kill();
    return true;
  }

  async kill(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.killProcessTree(this.proc.pid!, 'SIGTERM');
      } catch {
        // Process may have exited between guard check and here
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            this.killProcessTree(this.proc!.pid!, 'SIGKILL');
          } catch {
            // Already gone
          }
          resolve();
        }, 15_000);
        this.proc!.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    // Backstop: reaches grandchildren that escaped this.proc's process
    // group (setsid()) or were re-parented after it exited — the
    // process-group kill above can never see those. Runs unconditionally
    // (even when this.proc was already gone above) since such a
    // grandchild can outlive this.proc entirely.
    killSessionCgroup(this.sessionId);
  }

  /**
   * CLI mode has no destructible durable state beyond the OS process itself
   * — killing it is exactly what a graceful-restart pause needs, since
   * `resumeOrphanSessions` reattaches via `claude --resume <session-id>`
   * against the same on-disk state regardless of how the prior process exited.
   */
  async pause(): Promise<void> {
    await this.kill();
  }

  private killProcessTree(
    pid: number,
    signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
  ): void {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // Process may have already exited
      }
    } else {
      try {
        process.kill(-pid, signal);
      } catch {
        // ESRCH = process already gone
      }
    }
  }
}
