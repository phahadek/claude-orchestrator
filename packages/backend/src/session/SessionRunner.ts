/**
 * Options passed to a SessionRunner when starting a session.
 */
export interface SessionRunnerOptions {
  /** Working directory for the session (worktree path). */
  worktreePath: string;
  /** Claude model to use, e.g. 'claude-opus-4-6'. Undefined = CLI default. */
  model: string | undefined;
  /**
   * Reasoning effort to use, one of 'low' | 'medium' | 'high' | 'xhigh' | 'max'.
   * Undefined/empty = model default (no --effort flag).
   */
  effort?: string;
  /** Tool names to auto-approve (Bash(git:*), mcp__github__*, etc.) */
  allowedTools: string[];
  /**
   * Session type, used by CLI-mode runners to pick a type-aware
   * `--permission-mode` (see `session/sessionPredicates.ts#isPlanningSession`).
   * Planning/ops sessions must not run under `acceptEdits` — any tool call
   * outside their allowlist should hit a real permission denial (feeding the
   * grant-on-re-dispatch decision surface) rather than being silently
   * auto-accepted.
   */
  sessionType?: string;
  /**
   * The session's durable, operator-approved capability set (see
   * getGrantedCapabilities in db/queries.ts) — the raw grant strings, not
   * yet filtered to tool-shaped entries. CLI/Docker mode runners pass this
   * to `getSessionAddDirs` (orchestrator-config.ts) to widen the filesystem
   * read envelope by any granted `read:path:<abs-path>` capability.
   */
  granted?: string[];
  /**
   * System prompt content to inject (API mode only).
   * In CLI mode the content is delivered via --append-system-prompt-file instead.
   * In API mode this is passed as the `systemPrompt` option to the Agent SDK.
   */
  systemPrompt?: string;
  /**
   * Absolute path to a per-session MCP config JSON file (`{ mcpServers: {...} }`).
   * When set, CLI mode passes `--mcp-config <path> --strict-mcp-config` so only
   * the listed servers are registered (user-level servers are suppressed).
   * Undefined = no override (all user-level servers are inherited).
   */
  mcpConfigPath?: string;
  /**
   * Absolute path to a per-session orchestrator system-prompt file written
   * outside the worktree. When set, CLI mode appends
   * `--append-system-prompt-file <path>` to the spawn args so the session
   * receives its task spec / rules without any worktree write.
   */
  systemPromptFilePath?: string;
  /**
   * When true, spawns the CLI with `--settings '{"autoCompactEnabled":false}'`
   * to disable automatic context compaction for this spawn.
   * Per-spawn (not session-global) so a later escalation spawn can re-enable it.
   */
  disableAutoCompact?: boolean;
  /**
   * Extra environment variables to inject into the spawned session process
   * (CLI mode only). Used to deliver the session's per-session stage
   * credential and the backend's loopback port so the sanctioned CLI client
   * can submit staged task-write intents. Ignored by non-CLI runners.
   */
  extraEnv?: Record<string, string>;
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
   *
   * @returns true if the message was actually handed to the underlying
   * transport (stdin write succeeded / queued), false if delivery could not
   * be confirmed (e.g. a closed stdin pipe or a synchronous write failure).
   * Callers must not treat a false return as delivered.
   */
  sendMessage(message: string): boolean;

  /**
   * Signal a clean session end (close stdin / end the input stream), then
   * verify the underlying process actually exits. If it does not exit
   * within a bounded grace period, escalates to `kill()` (whole process
   * tree) so a session can never be marked terminal while its subprocess
   * lives on. Resolves once the process is confirmed gone, one way or
   * another.
   *
   * @param concludedCleanly whether this end follows a session that already
   * recorded why it's concluding (e.g. terminal_completion_reason) — purely
   * descriptive at this layer; see AgentSession.endSession for how it's
   * used to classify a forced escalation as a clean conclusion rather than
   * an unexpected kill.
   * @returns true if escalation to a forceful kill was required (the
   * process did not honor the graceful close), false if it exited on its
   * own. Callers use this to decide whether to audit the escalation.
   */
  endSession(concludedCleanly?: boolean): Promise<boolean>;

  /** Forcefully terminate the session. */
  kill(): Promise<void>;

  /**
   * True if the underlying transport failed to start
   * (e.g. spawn error, missing binary, invalid API key).
   */
  readonly hasSpawnError: boolean;
}
