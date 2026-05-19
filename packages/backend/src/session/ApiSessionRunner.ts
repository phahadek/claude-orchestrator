import type {
  ISessionRunner,
  RawSessionEvent,
  SessionRunnerOptions,
} from './SessionRunner';

/**
 * A push-based async iterable used to stream follow-up messages into the Agent SDK's
 * `query()` call. Callers push messages via `push()` and signal completion via `close()`.
 */
class MessageQueue {
  private readonly queue: unknown[] = [];
  private resolver: ((value: unknown) => void) | null = null;
  private closed = false;

  push(msg: unknown): void {
    if (this.resolver) {
      this.resolver(msg);
      this.resolver = null;
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    this.resolver?.(undefined);
    this.resolver = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.closed) {
        return;
      } else {
        const next = await new Promise<unknown>((resolve) => {
          this.resolver = resolve;
        });
        if (next === undefined) return;
        yield next;
      }
    }
  }
}

/**
 * Session runner that uses the `@anthropic-ai/claude-agent-sdk` to run sessions via the
 * Anthropic API instead of spawning a local `claude` subprocess.
 *
 * Key differences from CliSessionRunner:
 *  - Requires ANTHROPIC_API_KEY environment variable.
 *  - CLAUDE.md content is injected via the `systemPrompt` option rather than written to disk.
 *  - Uses `canUseTool` callback for permission control.
 *  - User settings (MCP servers etc.) are loaded from `~/.claude/settings.json`.
 */
export class ApiSessionRunner implements ISessionRunner {
  private abortController = new AbortController();
  private messageQueue: MessageQueue | null = null;
  private _hasSpawnError = false;
  private _killRequested = false;

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
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      this._hasSpawnError = true;
      throw new Error('ANTHROPIC_API_KEY is required for API session mode');
    }

    // Lazy import so the package is only required when actually used in API mode.

    const { query } = require('@anthropic-ai/claude-agent-sdk') as {
      query: (params: {
        prompt: string | AsyncIterable<unknown>;
        options?: Record<string, unknown>;
      }) => AsyncIterable<Record<string, unknown>>;
    };

    this.messageQueue = new MessageQueue();

    // For resumed sessions the initial prompt is sent later via sendMessage().
    // For new sessions, push the initial prompt into the stream immediately.
    if (initialPrompt) {
      this.messageQueue.push({
        type: 'user',
        message: { role: 'user', content: initialPrompt },
        parent_tool_use_id: null,
        session_id: '',
      });
    }

    const sdkOptions: Record<string, unknown> = {
      cwd: options.worktreePath,
      permissionMode: 'acceptEdits',
      allowedTools: options.allowedTools,
      abortController: this.abortController,
      // Load user MCP server configs from ~/.claude/settings.json so the same
      // MCP tools (Notion, GitHub, etc.) are available as in CLI mode.
      settingSources: ['user'],
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        _ctx: Record<string, unknown>,
      ): Promise<
        { behavior: 'allow' } | { behavior: 'deny'; message: string }
      > => {
        // All tools in the allowedTools list are pre-approved by the SDK's allowedTools option.
        // canUseTool only fires for tools NOT in that list — deny them.
        console.log(
          `[ApiSessionRunner ${this.sessionId.slice(0, 8)}] canUseTool: ${toolName} — not in allowedTools, denying`,
        );
        void input;
        return {
          behavior: 'deny',
          message: `Tool '${toolName}' is not in the allowed tools list`,
        };
      },
    };

    if (options.model) {
      sdkOptions.model = options.model;
    }

    if (resumeSessionId) {
      sdkOptions.resume = resumeSessionId;
    }

    // Inject CLAUDE.md content as system prompt (API mode equivalent of writing to disk).
    if (options.systemPrompt) {
      // Use the claude_code preset as the base and append our orchestrator rules.
      sdkOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: options.systemPrompt,
      };
    }

    try {
      const qry = query({ prompt: this.messageQueue, options: sdkOptions });

      for await (const message of qry) {
        if (this._killRequested) break;
        onEvent(message);
      }

      return this._killRequested ? null : 0;
    } catch (err) {
      if (this._killRequested) {
        // Abort was intentional — treat as clean kill
        return null;
      }
      console.error(
        `[ApiSessionRunner ${this.sessionId.slice(0, 8)}] error:`,
        err,
      );
      this._hasSpawnError = true;
      throw err;
    }
  }

  sendMessage(message: string): void {
    if (!this.messageQueue) return;
    this.messageQueue.push({
      type: 'user',
      message: { role: 'user', content: message },
      parent_tool_use_id: null,
      session_id: '',
    });
  }

  endSession(): void {
    this.messageQueue?.close();
  }

  async kill(): Promise<void> {
    this._killRequested = true;
    this.abortController.abort();
    this.messageQueue?.close();
  }
}
