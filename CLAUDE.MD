# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Fix: claude --resume always fails because orchestrator's session_id isn't passed as the CLI's conversation_id
- **Notion task**: https://www.notion.so/Fix-claude-resume-always-fails-because-orchestrator-s-session_id-isn-t-passed-as-the-CLI-s-conver-36c22f9152f381a690aaef8b3f22984f
- **Project context**: https://www.notion.so/33222f9152f38188b65fd912e40890a2

---

## Lifecycle

Follow these steps in order — every session:

> **Task spec is pre-loaded below.** Do NOT fetch Notion pages — the task content has
> already been injected by the orchestrator. Proceed directly to implementation.

1. Read the **Task Spec** section below — it contains the full task specification.
2. Create your task branch from the current HEAD: `git checkout -b feature/<task-name>`.
3. Implement the task per the acceptance criteria.
4. Pass the pre-PR gate (see Pre-PR Gate section below).
5. Open a draft PR targeting `dev` using the required body template.
6. **Stop and wait.** The dashboard sends review feedback as follow-up messages.
   Address findings by pushing additional commits, then wait again.

---

## Status Ownership

**Do NOT update Notion task status.**
**Do NOT call any Notion API to change task status.**
The orchestrator backend handles all status transitions (In Progress → In Review → Done).

---

## Efficiency Rules

This session runs in `--print` mode with no human watching the output.
Optimize for speed and token efficiency:

- **Do NOT use TodoWrite.** No one sees the todo list. Track your progress internally.
- **Do NOT use Agent subagents for exploration.** Use Glob and Grep directly.
- **Minimize tool calls.** Batch independent reads. Don't re-read files you already read.
- **Keep commit messages and PR descriptions concise.** One sentence summaries, not essays.

---

## PR Format Standards

- **Title**: `feat: <task-name>` — no scope prefix like `(backend)`, no milestone tags.
- **How to create the PR**: Use the `mcp__github__create_pull_request` MCP tool.
  Do NOT use `gh pr create` — the `gh` CLI is not on PATH.
  Pass `draft: true`, `base: "dev"`, and the full body as the `body` parameter.
- **Required body sections** (no omissions, no reordering):

```
## Summary
<1-3 sentences: what changed and why>

## Notion Task
<link to the Notion task page>

## Automated Tests
<list tests added/modified, or "No test changes">

## Files Changed
<bulleted list of files with brief description of each change>
```

---

## Branch Rules

- Branch name: `feature/<task-name>` — created from the worktree's current HEAD
- Never commit directly to `dev` or `main`
- Never merge your own PR
- One task per session — no scope creep

---

## Commit Attribution

Every commit **must** include the following trailer (replace `<model>` and `<session-id>` with your actual model ID and session ID):

```
AI-Authored-By: <model> (session: <session-id>)
```

Example: `AI-Authored-By: claude-sonnet-4-6 (session: f98ff4ec)`

The backend verifies this trailer server-side. In corporate mode, missing trailers pause the task.

---

## Pre-PR Gate

Run in order — all must pass before opening the PR:

1. Stash CLAUDE.md before rebasing: `git stash push CLAUDE.md`
2. Rebase onto `dev` and resolve any conflicts.
3. Restore CLAUDE.md: `git stash pop`
4. `npx tsc --noEmit -p packages/frontend/tsconfig.json` — must pass.
5. `npx tsc --noEmit -p packages/backend/tsconfig.json` — must pass.
6. `npm run build` — must pass.
7. Stage only your implementation files for commit — never stage `CLAUDE.md`.

---

## Forbidden Actions

- Never push directly to `main`
- Never force push (`--force`)
- Never delete branches that live outside this worktree
- Never run `git reset --hard` on the main repository directory
- Never skip pre-commit hooks (`--no-verify`)
- Never stage or commit `CLAUDE.md` — it contains orchestrator-injected content that must not appear in PRs. Use `git add <specific files>` instead of `git add .`.

---

## Git Isolation

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\da902cd6-1003-4d8a-8270-77ea7525d56d`.**
> This is your `cwd`. All commands run here. Never navigate to or operate on any parent directory.

- All git commands must run inside the worktree directory (your `cwd`)
- Never use `git -C <path>` pointing outside this worktree
- Never use `--work-tree` or `--git-dir` flags pointing outside this worktree
- Never run `git checkout` or `git switch` targeting a branch in the main repo directory
- The backend records the main repo branch before each session and will warn if it drifts

---

## Filesystem Isolation (Personal Mode)

> ⚠️ **Personal mode has no structural sandbox** — there is no docker, chroot, or
> namespace to prevent writes outside the worktree. All isolation is prompt-level.
> Violating these rules can corrupt the developer's live environment.

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\da902cd6-1003-4d8a-8270-77ea7525d56d`).

- **Never write to the project root or any path above the worktree.**
  Scripts, tools, and generated outputs must target paths under the worktree, not the parent repo.
- **Dev state (SQLite databases, log files, generated artifacts) must use worktree-relative paths.**
  Do not reference absolute paths to project-root databases or output files.
  Use paths like `<worktree>/.dev-state/<file>` or resolve paths relative to `cwd`.
- **Before running any script that writes files or opens a database, verify the target path is inside the worktree.**
  If a script hardcodes an absolute project-root path, patch it to accept an env var or relative path before executing.

---

## Bash Rules (Permission System)

Your Bash commands are authorized by prefix matching on the **first token**.
Violating these rules causes **silent denial** — the command fails with no error message.

**Rule 1 — One command per Bash call.**
Never chain with `&&`, `;`, or `||`. Split into separate Bash calls.

**Rule 2 — Never prefix with `cd path &&`.**
You are already in the worktree directory. Just run the command directly.

**Rule 3 — No heredoc subshells in git commit.**
`git commit -m "$(cat <<'EOF'...)"` is denied. Use a simple `-m "message"` instead.
For multiline commit messages, use `git commit -F <file>` and write the file with the Write tool first.

**Rule 4 — Do not write to `/tmp/` or paths outside the worktree.**
Use the Write tool for any file creation. Never use `cat >`, `printf >`, or `echo >` redirects.

**Rule 5 — Use `npx` instead of bare tool names.**
`tsc` → `npx tsc`. Bare commands may not be on PATH.

---

## Task Spec

> This is the full task specification, pre-fetched by the orchestrator.
> Do NOT re-fetch this from Notion — use the content below as your source of truth.

## Summary
Pass --session-id <sessionId> to the Claude CLI on initial spawn so the CLI uses the orchestrator's UUID as its conversation ID. Today the CLI generates its own conversation ID, which makes the orchestrator's later --resume <orchestrator-session-id> attempts fail with "No conversation found." This breaks every recovery path: backend restart, stuck-session detection, send-to-dead-session.
## Dependencies
None — Wave 1.
## Context
### Root cause
CliSessionRunner.ts:38-51 and DockerSessionRunner.ts:148-160 spawn the CLI with --print --output-format stream-json … but never pass --session-id. The CLI generates its own conversation ID per spawn (we observed 06330dcb, 3205bb21, 30d50fcd, 4cf5f53a for two orchestrator-tracked sessions c8ee68b9 and 3edb8e7d).
When SessionManager.ts:761 later tries to resume, it passes row.session_id (the orchestrator's UUID) to --resume:
```typescript
row.session_id, // resumeSessionId — passes --resume to CLI / SDK
```
The CLI has no conversation with that ID and immediately errors:
```javascript
stderr: No conversation found with session ID: c8ee68b9-d982-4ee4-a6ca-f9448d49a57e
```
It returns result(error_during_execution, num_turns: 0, duration_ms: 0) and exits. The orchestrator catches the failure, marks the session as error, and sends RESUME_NUDGE_MESSAGE ("Continue implementing the task…") to a stdin that's already closed.
Confirmed on 2026-05-26: two sessions launched at 22:52 UTC for the two milestone-switch bug-fix tasks died at 22:56:36 / 22:57:02 without a result event in their JSONL. The orchestrator then tried to resume them, the resume failed for the reason above, and they were finalized as error.
### Fix
The Claude CLI supports --session-id <uuid> (confirmed via claude --help):
> --session-id <uuid>  Use a specific session ID for the conversation (must be a valid UUID)
In CliSessionRunner.ts:38-51, change the spawnArgs construction so initial spawns include --session-id:
```typescript
const spawnArgs = [
  ...(resumeSessionId
    ? ['--resume', resumeSessionId]
    : ['--session-id', this.sessionId]),
  '--print',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'acceptEdits',
  ...(model ? ['--model', model] : []),
  '--allowed-tools',
  ...allowedTools,
];
```
Apply the same change to DockerSessionRunner.ts:148-160. Use --session-id and --resume mutually exclusively — one or the other, never both.
Constraint: this.sessionId is already a valid UUID generated by the orchestrator (SessionManager calls randomUUID() when creating new sessions). No new ID generation needed.
### Out of scope
- Backfilling existing sessions whose CLIs already used self-generated IDs — they remain unresumable. That's an accepted one-time loss.
- A separate "captured CLI session_id" column. Once this fix lands, the orchestrator's session_id IS the CLI's conversation_id, so no separate tracking needed.
## Acceptance criteria
### 🤖 Automated tests
tsc --noEmit passes for both packages
Unit test (CliSessionRunner): initial-spawn args (no resumeSessionId) include --session-id <sessionId> and do not include --resume
Unit test (CliSessionRunner): resume-spawn args (with resumeSessionId) include --resume <resumeSessionId> and do not include --session-id
Unit test (DockerSessionRunner): same two assertions on the constructed docker-run claude args
Existing resumeOrphan.integration.test.ts continues to pass
### 👁️ Manual verification
Launch a session, kill the orchestrator backend mid-session, restart. The orphan-resume completes successfully — claude --resume <sessionId> finds the conversation and continues. The session does not end in error with error_during_execution. (In M6 gate.)
## Files / paths affected
- packages/backend/src/session/CliSessionRunner.ts (update)
- packages/backend/src/session/DockerSessionRunner.ts (update)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/session/CliSessionRunner.ts`
```
import { spawn, ChildProcess, execSync } from 'child_process';
import { createInterface } from 'readline';
import { config } from '../config';
import type {
  ISessionRunner,
  RawSessionEvent,
  SessionRunnerOptions,
} from './SessionRunner';

function log(sessionId: string, ...args: unknown[]) {
  console.log(`[CliSessionRunner ${sessionId.slice(0, 8)}]`, ...args);
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
    const { worktreePath, model, allowedTools } = options;

    const spawnArgs = [
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
      console.error(`[CliSessionRunner] spawn error: ${err.message}`);
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
        console.error(
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
      this.killProcessTree(this.proc.pid!);
    } catch {
      // Process may have exited between guard check and here
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          this.killProcessTree(this.proc!.pid!);
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

  private killProcessTree(pid: number): void {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // Process may have already exited
      }
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // ESRCH = process already gone
      }
    }
  }
}

```

### `packages/backend/src/session/DockerSessionRunner.ts`
```
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

    // 5. Teardown containers and netw
[... truncated]
```

---

## Local Context

> Host-local context loaded from `.claude/local-context.md`.

# Local Context — host-specific configuration

This file is **gitignored**. It contains environment-specific URLs, IDs, and
references that should never be committed to the repo.

The orchestrator backend automatically appends the contents of this file to the
merged `CLAUDE.md` written into each session worktree.

---

## Project Context

- **Project Context page** (Notion): https://www.notion.so/Claude-Code-Dashboard-33222f9152f38188b65fd912e40890a2
- **Active Task Board** (Notion): https://www.notion.so/3edf1af401744a158c0e116810a8ce07

## Design & Architecture

- **Product Design Doc**: https://www.notion.so/33222f9152f381b99db7ead36cfcf057
- **Technical Architecture**: https://www.notion.so/33222f9152f3812681a3c9be7ae4270c
- **Dev Setup & Git**: https://www.notion.so/33222f9152f381098a9ffc16a8bd46cb
- **Coding Guidelines**: https://www.notion.so/33322f9152f3811ca9e7de3be99c2e06
- **Task Writing Guidelines**: https://www.notion.so/33222f9152f381738b77e8e972be7419
- **Backlog Grooming Sessions**: https://www.notion.so/33622f9152f3811d8e4de56b74fb0eb4

## Boards (per milestone)

- **M1 — MVP (Session Browser + Streaming UI)**: https://www.notion.so/cc16d2649d594a2dbc6ca7b056d095b0 — ✅ Done (2026-03-31)
- **M2 — Multi-Project & Interactive Sessions**: https://www.notion.so/4c30510be98448e49ffa6f7917650ee6 — ✅ Done (2026-04-02)
- **M2a — Orchestrator & Lifecycle Automation**: https://www.notion.so/19287f317923488b8533f02704f1396e — ✅ Done (2026-04-03)
- **M3 — Polish & Public Release**: https://www.notion.so/ca4d62a52c1a468bb23f2419dc8cc94b — 🔲 Active
- **M4 — Stabilize for Full-Auto**: https://www.notion.so/58383a0cf4424fa3a23223eebee97459 — ✅ Done (2026-05-22)
- **M5 — Privacy, Bit-rot & UX Polish**: https://www.notion.so/2932df9453ea47d7827b8c17758d77d8 — ✅ Done (2026-05-26)
- **M6 — Enterprise Adoption Readiness**: https://www.notion.so/3edf1af401744a158c0e116810a8ce07 — 🔲 Active

## Notes

- Current phase: **M6 — Enterprise Adoption Readiness**
- Filter the active task board to `💻 Code` type tasks unless instructed otherwise.