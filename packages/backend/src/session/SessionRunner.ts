/**
 * Options passed to a SessionRunner when starting a session.
 */
export interface SessionRunnerOptions {
  /** Working directory for the session (worktree path). */
  worktreePath: string;
  /** Claude model to use, e.g. 'claude-opus-4-6'. Undefined = CLI default. */
  model: string | undefined;
  /** Tool names to auto-approve (Bash(git:*), mcp__github__*, etc.) */
  allowedTools: string[];
  /**
   * System prompt content to inject.
   * - CLI mode: this content is written to CLAUDE.md in the worktree before spawn.
   * - API mode: this is passed as the `systemPrompt` option to the Agent SDK.
   */
  systemPrompt?: string;
  /**
   * Absolute path to a per-session MCP config JSON file (`{ mcpServers: {...} }`).
   * When set, CLI mode passes `--mcp-config <path> --strict-mcp-config` so only
   * the listed servers are registered (user-level servers are suppressed).
   * Undefined = no override (all user-level servers are inherited).
   */
  mcpConfigPath?: string;
}

/**
 * Raw event object emitted by the underlying session transport.
 * CLI mode emits the stream-json events from the claude subprocess.
 * API mode normalises SDK messages to the same shape.
 */
export type RawSessionEvent = Record<string, unknown>;

/**
 * Interface for the I/O adapter that backs an AgentSession.
 *
 * Two implementations exist:
 *  - CliSessionRunner  — spawns `claude --print --output-format stream-json`
 *  - ApiSessionRunner  — uses `@anthropic-ai/claude-agent-sdk` query()
 *
 * Both emit raw JSON events in the same shape as the CLI stream-json protocol
 * so that the AgentSession event-processing pipeline is transport-agnostic.
 */
export interface ISessionRunner {
  /**
   * Start the underlying transport and stream events to the caller.
   *
   * @param initialPrompt  - Initial user prompt, or undefined when resuming.
   * @param resumeSessionId - CLI session ID to resume (--resume), or undefined for new sessions.
   * @param options        - Runner configuration.
   * @param onEvent        - Called for each raw JSON event produced by the transport.
   * @returns              - The process exit code (0 = clean, null = killed/signal).
   *
   * Resolves when the session exits. Throws on spawn/init error.
   */
  run(
    initialPrompt: string | undefined,
    resumeSessionId: string | undefined,
    options: SessionRunnerOptions,
    onEvent: (event: RawSessionEvent) => void,
  ): Promise<number | null>;

  /**
   * Deliver a follow-up user message to the running session.
   * No-op if the session is not running.
   */
  sendMessage(message: string): void;

  /**
   * Signal a clean session end (close stdin / end the input stream).
   * The session finishes its current turn and exits.
   */
  endSession(): void;

  /** Forcefully terminate the session. */
  kill(): Promise<void>;

  /**
   * True if the underlying transport failed to start
   * (e.g. spawn error, missing binary, invalid API key).
   */
  readonly hasSpawnError: boolean;
}
