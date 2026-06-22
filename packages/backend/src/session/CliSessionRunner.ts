import { spawn, ChildProcess, execSync } from 'child_process';
import { createInterface } from 'readline';
import {
  config,
  BASH_MAX_OUTPUT_LENGTH,
  BASH_DEFAULT_TIMEOUT_MS,
} from '../config';
import type {
  ISessionRunner,
  RawSessionEvent,
  SessionRunnerOptions,
} from './SessionRunner';
import { logger } from '../logger';

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
      allowedTools,
      mcpConfigPath,
      disableAutoCompact,
    } = options;

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
      'acceptEdits',
      ...(model ? ['--model', model] : []),
      ...(disableAutoCompact
        ? ['--settings', '{"autoCompactEnabled":false}']
        : []),
      ...(mcpConfigPath
        ? ['--mcp-config', mcpConfigPath, '--strict-mcp-config']
        : []),
      '--allowed-tools',
      ...allowedTools,
    ];

    const envKeys = ['PROJECT_DIR', 'SESSIONS_DIR', 'DB_PATH'] as const;
    const envStr = envKeys
      .filter((k) => process.env[k] !== undefined)
      .map((k) => `${k}=${process.env[k]}`)
      .join(', ');
    log(
      this.sessionId,
      `spawning: cwd=${worktreePath} cmd=${config.claudePath} ${spawnArgs.join(' ')} env={${envStr}}`,
    );

    this.proc = spawn(config.claudePath, spawnArgs, {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BASH_MAX_OUTPUT_LENGTH: String(BASH_MAX_OUTPUT_LENGTH),
        BASH_DEFAULT_TIMEOUT_MS: String(BASH_DEFAULT_TIMEOUT_MS),
      },
      ...(process.platform !== 'win32' && { detached: true }),
    });

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

    return exitCode;
  }

  sendMessage(message: string): void {
    if (!this.proc?.stdin?.writable) return;
    try {
      this.proc.stdin.write(
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
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.end();
    }
  }

  async kill(): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) return;
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
