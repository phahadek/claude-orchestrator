# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Implement corporate-mode config layer
- **Notion task**: https://www.notion.so/Implement-corporate-mode-config-layer-36b22f9152f38169b178de7f5e2bea42
- **Project context**: https://www.notion.so/33222f9152f38188b65fd912e40890a2

---

## Lifecycle

Follow these steps in order — every session:

> **Task spec is pre-loaded below.** Do NOT fetch Notion pages — the task content has
> already been injected by the orchestrator. Proceed directly to implementation.

1. Read the **Task Spec** section below — it contains the full task specification.
2. Create a feature branch: `feature/<task-name>` from `dev`.
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

- Branch name: `feature/<task-name>` from `dev`
- Never commit directly to `dev` or `main`
- Never merge your own PR
- One task per session — no scope creep

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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\8145f83a-adc0-42f0-83b7-1d02af328bd1`.**
> This is your `cwd`. All commands run here. Never navigate to or operate on any parent directory.

- All git commands must run inside the worktree directory (your `cwd`)
- Never use `git -C <path>` pointing outside this worktree
- Never use `--work-tree` or `--git-dir` flags pointing outside this worktree
- Never run `git checkout` or `git switch` targeting a branch in the main repo directory
- The backend records the main repo branch before each session and will warn if it drifts

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
Implement the corporateMode.ts config layer designed in Wave-1 — a single per-install flag with five gates, queried by downstream features. Plus a small one-shot allowlist cleanup: remove three vestigial entries from ALLOWED_TOOLS that aren't used by spawned sessions.
## Dependencies
- Design corporate-mode config (gates, defaults, lockdown surface)
## Context
Per the corporate-mode design (T4), this task implements:
1. A small read-only module that exposes the corporate-mode state + 5 gates
1. Startup loading from env var (primary) with settings-table fallback
1. A startup-log line for operators to confirm the mode
1. A vestigial-entry cleanup in ALLOWED_TOOLS
The 5 gates are: dockerMandatory, requireHumanApproval, requireZDR, validatePRBody, secretsViaSeam. Downstream tasks (T10, T12, T15, T16, T17) wire to specific gates at their own decision points.
### API surface
```typescript
// packages/backend/src/config/corporateMode.ts (new)
export interface CorporateModeGates {
  dockerMandatory: boolean;
  requireHumanApproval: boolean;
  requireZDR: boolean;
  validatePRBody: boolean;
  secretsViaSeam: boolean;
}

export interface CorporateModeConfig {
  enabled: boolean;
  envLocked: boolean;             // true if set via env var (UI read-only)
  gates: CorporateModeGates;
}

export function getCorporateMode(): CorporateModeConfig;
```
Loaded once at startup; cached. getCorporateMode() is the entry point for all downstream queries.
### Load order
1. Read ORCHESTRATOR_MODE env var. Values: corporate | personal | unset.
1. If env var is set, that's the mode; envLocked = true.
1. If unset, query the settings table for corporate_mode row (values: corporate | personal); envLocked = false.
1. If neither: default to personal.
When enabled === true, all 5 gates are true. When enabled === false, all 5 gates are false. Monolithic on/off — no per-gate overrides in M6.
### Always-on allowlist cleanup (one-shot, not corporate-mode-gated)
Remove three entries from ALLOWED_TOOLS in packages/backend/src/config.ts:73-100:
- Bash(gh:*) — Vestigial. Project CLAUDE.md instructs sessions NOT to use gh pr create; PR creation goes through mcp__github__*.
- mcp__claude_ai_Asana__* — Vestigial. No spawned-coding-session use case.
- mcp__claude_ai_Google_Calendar__* — Vestigial. No spawned-coding-session use case.
These cuts apply to all installs regardless of mode.
### Startup logging
Emit at startup, INFO level:
```javascript
[corporateMode] mode=corporate envLocked=true gates={dockerMandatory:true, requireHumanApproval:true, requireZDR:true, validatePRBody:true, secretsViaSeam:true}
```
Operators can confirm the mode at process boot without trawling the DB or UI.
### Out of scope
- Hot-reload: deliberately not supported in M6. Restart required to change.
- Per-gate overrides: monolithic on/off in M6. Per-gate overrides are Future Scope if a real use case emerges.
- UI for toggling the settings-table row: deferred. The fallback path exists; the UI to flip it can come in a follow-up. For M6, personal users who want to toggle should edit the row directly via the existing settings infra.
### Files likely to change
- packages/backend/src/config/corporateMode.ts (new — the module)
- packages/backend/src/config.ts (update — wire corporate-mode loading at startup; remove three vestigial allowlist entries)
- packages/backend/src/server.ts (update — emit startup log line after corporate-mode is loaded)
T8 does not touch CliSessionRunner.ts — the strict-allowlist work was investigated in T4 design and dropped (too thin under prefix-only matching).
## Acceptance criteria
### 🤖 Automated tests
tsc --noEmit passes for both packages
Unit test: getCorporateMode() returns enabled: false, envLocked: false when neither env nor settings is set
Unit test: getCorporateMode() returns enabled: true, envLocked: true when ORCHESTRATOR_MODE=corporate is in env
Unit test: getCorporateMode() returns enabled: true, envLocked: false when env is unset and settings-table has corporate_mode=corporate
Unit test: env wins over settings-table (env=personal overrides settings=corporate)
Unit test: when enabled === true, all 5 gates are true
Unit test: when enabled === false, all 5 gates are false
Backend startup logs the corporate-mode status line
After change: ALLOWED_TOOLS array no longer contains Bash(gh:*), mcp__claude_ai_Asana__*, or mcp__claude_ai_Google_Calendar__*
### 👁️ Manual verification
Covered by the Manual Verification Gate task.
## Files / paths affected
- packages/backend/src/config/corporateMode.ts (new)
- packages/backend/src/config.ts (update)
- packages/backend/src/server.ts (update)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/config.ts`
```
export interface Board {
  /** Milestone row id — used as the milestoneId for WS fetch_tasks. */
  id: string;
  /** Notion database id (milestone.source_id) — used internally by NotionTaskBackend. */
  sourceId: string;
  name: string;
}

export interface ProjectConfig {
  id: string; // unique key, e.g. "claude-orchestrator"
  name: string;
  projectDir: string; // absolute path to the repo root
  contextUrl: string;
  boardId: string; // default/active board (backwards compat — first milestone)
  boards?: Board[]; // multi-milestone support — derived from milestones table
  githubRepo?: string; // "owner/repo" — optional; enables PR features
  taskSource: 'notion' | 'yaml'; // honored by getTaskBackend(projectId)
  gitMode: 'github' | 'local-only'; // 'github' (default) or 'local-only' (no GitHub remote)
  autoLaunchEnabled: boolean; // per-project toggle for the AutoLauncher
  autoLaunchMilestoneId: string | null; // milestone the AutoLauncher polls; null = first milestone
  autoMergeEnabled: boolean; // per-project toggle for the AutoMerger
}

function resolveClaudePath(): string {
  const explicit = process.env.CLAUDE_PATH;
  if (explicit) return explicit;
  // On Windows, spawn('claude', ..., { cwd }) fails if claude isn't in the
  // system PATH. Resolve the full path at startup so it always works.
  try {
    const { execSync } =
      require('child_process') as typeof import('child_process');
    return execSync(
      process.platform === 'win32' ? 'where claude' : 'which claude',
      {
        encoding: 'utf8',
      },
    )
      .trim()
      .split('\n')[0];
  } catch {
    return 'claude'; // fallback — hope it's on PATH
  }
}

/** Convert Git Bash paths like /c/Users/... to C:/Users/... for Windows Node. */
export function normalizePath(p: string): string {
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(p)) {
    return p[1].toUpperCase() + ':' + p.slice(2);
  }
  return p;
}

export const config = {
  notionApiKey: process.env.NOTION_API_KEY ?? '',
  sqlitePath: process.env.DB_PATH ?? './dashboard.db',
  port: Number(process.env.PORT ?? 3000),
  projectDir: normalizePath(process.env.PROJECT_DIR ?? process.cwd()),
  claudePath: resolveClaudePath(),
  maxConcurrentCodeSessions: Number(
    process.env.MAX_CONCURRENT_CODE_SESSIONS ?? 20,
  ),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
};

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
export const GITHUB_REPO = process.env.GITHUB_REPO ?? ''; // "owner/repo"

export const AUTO_REVIEW_ENABLED = process.env.AUTO_REVIEW !== 'false';
export const AUTO_REVIEW_CONCURRENCY = Number(
  process.env.AUTO_REVIEW_CONCURRENCY ?? 1,
);

export const ALLOWED_TOOLS = [
  'Bash(git:*)',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(node:*)',
  'Bash(tsc:*)',
  'Bash(gh:*)',
  'Bash(cd:*)',
  'Bash(which:*)',
  'Bash(where:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(echo:*)',
  'Bash(mkdir:*)',
  'Bash(cp:*)',
  'Bash(mv:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(find:*)',
  'Bash(grep:*)',
  'Bash(sort:*)',
  'Bash(pwd:*)',
  'mcp__claude_ai_Notion__*',
  'mcp__github__*',
  'mcp__claude_ai_Asana__*',
  'mcp__claude_ai_Google_Calendar__*',
];

function hydrateProject(p: {
  id: string;
  name: string;
  projectDir: string;
  contextUrl: string | null;
  githubRepo: string | null;
  taskSource: 'notion' | 'yaml';
  gitMode: 'github' | 'local-only';
  autoLaunchEnabled: boolean;
  autoLaunchMilestoneId: string | null;
  autoMergeEnabled: boolean;
  milestones: { id: string; sourceId: string | null; name: string }[];
}): ProjectConfig {
  // boards[].id is now the milestone row id (used as milestoneId for fetch_tasks).
  // boards[].sourceId is the Notion database id (used internally by NotionTaskBackend).
  // YAML projects keep their milestones in boards as well — their sourceId is empty.
  const boards: Board[] = p.milestones.map((m) => ({
    id: m.id,
    sourceId: m.sourceId ?? '',
    name: m.name,
  }));
  const config: ProjectConfig = {
    id: p.id,
    name: p.name,
    projectDir: p.projectDir,
    contextUrl: p.contextUrl ?? '',
    boardId: boards[0]?.id ?? '',
    taskSource: p.taskSource,
    gitMode: p.gitMode,
    autoLaunchEnabled: p.autoLaunchEnabled,
    autoLaunchMilestoneId: p.autoLaunchMilestoneId,
    autoMergeEnabled: p.autoMergeEnabled,
  };
  if (boards.length > 0) config.boards = boards;
  if (p.githubRepo) config.githubRepo = p.githubRepo;
  return config;
}

export function getProjectById(id: string): ProjectConfig | undefined {
  // Lazy import avoids a circular dependency between config <-> ProjectService.
  const { ProjectService } =
    require('./projects/ProjectService') as typeof import('./projects/ProjectService');
  const project = ProjectService.getById(id);
  return project ? hydrateProject(project) : undefined;
}

export function getAllProjects(): ProjectConfig[] {
  const { ProjectService } =
    require('./projects/ProjectService') as typeof import('./projects/ProjectService');
  return ProjectService.list().map(hydrateProject);
}

export function getProjectByGithubRepo(
  githubRepo: string,
): ProjectConfig | undefined {
  return getAllProjects().find((p) => p.githubRepo === githubRepo);
}

export interface RuntimeSettings {
  max_concurrent_code_sessions: number;
  auto_review_concurrency: number;
  auto_review: boolean;
  card_preview_lines: number;
  code_session_model: string;
  review_session_model: string;
  /** Session launch mode: 'cli' uses the claude subprocess, 'api' uses the Agent SDK. */
  session_mode: 'cli' | 'api';
  /** Global concurrency cap for AutoLauncher-spawned code sessions. */
  auto_launch_concurrency: number;
  /** AutoLauncher poll interval in milliseconds. */
  auto_launch_poll_interval_ms: number;
  /** Stuck-session timer: seconds before emitting a notify toast. */
  session_notify_threshold_seconds: number;
  /** Stuck-session timer: seconds before injecting a pause message. */
  session_pause_threshold_seconds: number;
  /** After pause, seconds during which a tool_use triggers a hard-stop. */
  session_hard_stop_window_seconds: number;
  /** Auto-merger: seconds between CI status polls while waiting for green. */
  ci_poll_interval_seconds: number;
  /** Auto-merger: minutes before the merge attempt gives up and pauses. */
  ci_poll_max_minutes: number;
  /** Max review iterations before escalating to manual. */
  max_review_iterations: number;
}

/** Mutable in-memory settings, seeded from env and overridden by DB on startup. */
export const runtimeSettings: RuntimeSettings = {
  max_concurrent_code_sessions: Number(
    process.env.MAX_CONCURRENT_CODE_SESSIONS ?? 20,
  ),
  auto_review_concurrency: Number(process.env.AUTO_REVIEW_CONCURRENCY ?? 1),
  auto_review: (process.env.AUTO_REVIEW ?? 'true') !== 'false',
  card_preview_lines: Number(process.env.CARD_PREVIEW_LINES ?? 3),
  code_session_model: '',
  review_session_model: '',
  session_mode: process.env.SESSION_MODE === 'api' ? 'api' : 'cli',
  auto_launch_concurrency: Number(process.env.AUTO_LAUNCH_CONCURRENCY ?? 1),
  auto_launch_poll_interval_ms: Number(
    process.env.AUTO_LAUNCH_POLL_INTERVAL_MS ?? 60_000,
  ),
  session_notify_threshold_seconds: Number(
    process.env.SESSION_NOTIFY_THRESHOLD_SECONDS ?? 3600,
  ),
  session_pause_threshold_seconds: Number(
    process.env.SESSION_PAUSE_THRESHOLD_SECONDS ?? 7200,
  ),
  session_hard_stop_window_seconds: Number(
    process.env.SESSION_HARD_STOP_WINDOW_SECONDS ?? 60,
  ),
  ci_poll_interval_seconds: Number(process.env.CI_POLL_INTERVAL_SECONDS ?? 30),
  ci_poll_max_minutes: Number(process.env.CI_POLL_MAX_MINUTES ?? 30),
  max_review_iterations: 3,
};

```

### `packages/backend/src/server.ts`
```
import './bootstrap';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import os from 'os';
import { runMigrations } from './db/schema';
import { db } from './db/db';
import { SessionManager } from './session/SessionManager';
import { handleMessage } from './ws/router';
import { sendInitialStateBurst } from './ws/initialStateBurst';
import { JsonlReader, DEFAULT_SESSIONS_DIR } from './session/JsonlReader';
import type { ServerMessage } from './ws/types';
import {
  permissionEventsRouter,
  permissionDenialsRouter,
} from './routes/rules';
import configRouter from './routes/config';
import settingsRouter, { loadRuntimeSettingsFromDb } from './routes/settings';
import { sessionsRouter, setBroadcast } from './routes/sessions';
import { createPrsRouter, setPRBroadcast } from './routes/prs';
import { createTasksRouter, setTaskBroadcast } from './routes/tasks';
import { analyticsRouter } from './routes/analytics';
import { projectsRouter, setAutoMerger } from './routes/projects';
import { importProjectsFromEnv } from './projects/projectImport';
import { GitHubClient } from './github/GitHubClient';
import { PRReviewService } from './github/PRReviewService';
import { ReviewOrchestrator } from './github/ReviewOrchestrator';
import { PRMergeWatcher } from './github/PRMergeWatcher';
import { AutoMerger } from './github/AutoMerger';
import { AUTO_REVIEW_ENABLED, AUTO_REVIEW_CONCURRENCY } from './config';
import { AutoLauncher } from './orchestration/AutoLauncher';
import { StuckSessionMonitor } from './orchestration/StuckSessionMonitor';
import {
  deleteGhostSessions,
  getPRBySessionId,
  setPRReviewResult,
  setLastReviewedSha,
  setHeadSha,
  getSetting,
  setPendingPush,
  setPauseReason,
} from './db/queries';
import { shouldAutoReview, formatReviewFeedback } from './github/reviewUtils';
import type { PRReviewResult } from './github/PRReviewService';

runMigrations();
loadRuntimeSettingsFromDb();
importProjectsFromEnv(process.env.PROJECTS);

const ghostsRemoved = deleteGhostSessions();
if (ghostsRemoved > 0) {
  console.log(
    `[server] cleaned up ${ghostsRemoved} ghost session(s) with no events`,
  );
}

const rawSessionsDir = process.env.SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR;
const sessionsDir = rawSessionsDir.replace(/^~/, os.homedir());
const jsonlReader = new JsonlReader(sessionsDir);

if (process.env.TASK_BACKEND) {
  console.warn(
    '[startup] TASK_BACKEND env var is deprecated and ignored. ' +
      'task_source is now configured per-project in SQLite.',
  );
}

const githubClient = new GitHubClient();

const sessionManager = new SessionManager(githubClient);
const prReviewService = new PRReviewService(
  githubClient,
  undefined,
  sessionManager,
);
// Retained so push_detected handler can call consumeAutofixSha() to detect
// autofix-only pushes and suppress iteration-counter increments for them.
const reviewOrchestrator = new ReviewOrchestrator(
  prReviewService,
  sessionManager,
  AUTO_REVIEW_CONCURRENCY,
  AUTO_REVIEW_ENABLED,
  githubClient,
);

const PORT = parseInt(process.env.PORT ?? '3000');

const app = express();
app.use(express.json());
app.use('/api/permission-events', permissionEventsRouter);
app.use('/api/permission-denials', permissionDenialsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/sessions', sessionsRouter);
// PRMergeWatcher created early so routes and sync jobs can delegate lifecycle to it.
// .start() is called later after server boots.
const prMergeWatcher = new PRMergeWatcher(
  githubClient,
  sessionManager,
  undefined,
  broadcast,
);
// After an approved verdict, the review service should trigger an immediate
// watcher-style mergeability check so we don't wait for the next 5-min poll.
prReviewService.setMergeWatcher(prMergeWatcher);
const autoMerger = new AutoMerger(
  githubClient,
  prMergeWatcher,
  broadcast,
  sessionManager,
);
prMergeWatcher.setAutoMerger(autoMerger);
prReviewService.setAutoMerger(autoMerger);
setAutoMerger(autoMerger);
app.use(
  '/api',
  createPrsRouter(
    githubClient,
    prReviewService,
    sessionManager,
    undefined,
    prMergeWatcher,
    autoMerger,
  ),
);
app.use('/api', createTasksRouter());
app.use('/api/analytics', analyticsRouter);
app.use('/api', projectsRouter);
app.use('/api', configRouter);
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')),
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg: ServerMessage) {
  const json = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  });
}

// Wire broadcast into the sessions router (for PATCH note/tags)
setBroadcast(broadcast);
// Wire broadcast into the prs router (for merge/close events)
setPRBroadcast(broadcast);
// Wire broadcast into the tasks route (for task_updated WS messages)
setTaskBroadcast(broadcast);

// Broadcast all session events to every connected WS client
sessionManager.on('message', broadcast);

// ── Push-detected re-review loop ─────────────────────────────────────────────

const PUSH_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REVIEW_ITERATIONS = 3;
const pendingReReviews = new Set<string>();

function getMaxReviewIterations(): number {
  const raw = getSetting('max_review_iterations');
  if (!raw) return DEFAULT_MAX_REVIEW_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_REVIEW_ITERATIONS;
}

sessionManager.on(
  'push_detected',
  ({ sessionId: codingSessionId }: { sessionId: string }) => {
    console.log(
      `[server] push_detected from session ${codingSessionId.slice(0, 8)}`,
    );
    if (!AUTO_REVIEW_ENABLED) {
      console.log('[server] push_detected: auto-review disabled');
      return;
    }
    if (pendingReReviews.has(codingSessionId)) {
      console.log('[server] push_detected: already pending for this session');
      return;
    }

    const prRow = getPRBySessionId(codingSessionId);
    if (!prRow || prRow.state !== 'open') {
      console.log(
        `[server] push_detected: no open PR for session (found=${!!prRow})`,
      );
      return;
    }
    if (!prRow.review_session_id) {
      // Initial review hasn't started yet — queue the push so it triggers
      // re-review after the initial review session is established.
      setPendingPush(prRow.pr_number, prRow.repo, 1);
      console.log(
        `[server] push_detected for PR #${prRow.pr_number} before review session established — queued as pending_push`,
      );
      return;
    }

    pendingReReviews.add(codingSessionId);

    void (async () => {
      let headSha = prRow.head_sha;
      let fetchError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const freshPR = await githubClient.fetchPR(
            prRow.repo,
            prRow.pr_number,
          );
          headSha = freshPR.headSha;
          fetchError = undefined;
          if (headSha !== prRow.head_sha) {
            setHeadSha(prRow.pr_number, prRow.repo, headSha);
          }
          break;
        } catch (e) {
          fetchError = e;
          if (attempt === 0) {
            console.warn(
              `[server] fetch PR #${prRow.pr_number} failed (attempt 1), retrying...`,
            );
            await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          }
        }
      }
      if (fetchError) {
        console.warn(
          `[server] failed to fetch latest PR state for #${prRow.pr_number} after retry:`,
          fetchError,
        );
      }

      // Skip re-review when the only push since the last review was the autofix
      // commit — the code at that SHA was already reviewed in executeReview().
      // This prevents autofix-only iterations from counting agains
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