# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Config schema migration: .env to config.json in data dir
- **Notion task**: https://www.notion.so/Config-schema-migration-env-to-config-json-in-data-dir-37022f9152f38150bf95c7615c008d9c
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
- **Prefer Edit over Write for files that already exist.** Only use Write to create a new file or when replacing the majority of a file. Never re-emit an unchanged file body.
- **Never Read a file you just wrote or edited** — you already know its contents and line layout.
- **Never Read/cat raw `tasks/*.output` background-task files** — they bypass the Bash output cap. Use the TaskOutput tool if you must inspect a backgrounded command's output.

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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\d98d4965-a2d4-4476-bfe5-fd01781d4481`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\d98d4965-a2d4-4476-bfe5-fd01781d4481`).

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
For multiline commit messages, write the message to `.claude/.commit-msg` with the Write tool, then run `git commit -F .claude/.commit-msg`. **Use that exact path** — the `.claude/` directory is gitignored, so the scratch file is never accidentally staged. Do not invent other filenames (`commit-msg.txt`, `.git-commit-msg.txt`, etc.) — they will leak into the PR diff.

**Rule 4 — Do not write to `/tmp/` or paths outside the worktree.**
Use the Write tool for any file creation. Never use `cat >`, `printf >`, or `echo >` redirects.

**Rule 5 — Use `npx` instead of bare tool names.**
`tsc` → `npx tsc`. Bare commands may not be on PATH.

---

## Task Spec

> This is the full task specification, pre-fetched by the orchestrator.
> Do NOT re-fetch this from Notion — use the content below as your source of truth.

## Summary
Replace the current .env-based config with config.json living in the per-OS data directory. Migrate backward-compatibly: if config.json is missing but a .env is present in the legacy location, import it on first read. This is the foundation for both the installer-mode storage and the first-run wizard's output.
## Dependencies
None.
## Context
Decisions already locked by the installer + distribution design:
- Data dir per OS: %APPDATA%\ClaudeOrchestrator\ (Win) / ~/Library/Application Support/ClaudeOrchestrator/ (macOS) / ${XDG_CONFIG_HOME:-~/.config}/claude-orchestrator/ (Linux config; data at ${XDG_DATA_HOME:-~/.local/share}/claude-orchestrator/)
- Holds dashboard.db, config.json, logs/, worktree root
- Existing developer-mode (clone + npm install + .env) must continue to work
- Existing config knobs preserved — just a different ingress
Current config consumers (reading from packages/backend/.env):
- NOTION_API_KEY, GITHUB_TOKEN, GITHUB_REPO, PORT, DB_PATH, SESSIONS_DIR, AUTO_REVIEW, AUTO_REVIEW_CONCURRENCY
- Plus the one-shot legacy PROJECTS env var importer (already deprecated)
Fix shape:
1. Define a ConfigSource interface with read(): OrchestratorConfig and write(partial: Partial<OrchestratorConfig>): void.
1. Implement two concrete sources: DataDirConfigSource (reads/writes config.json in the OS data dir) and EnvFileConfigSource (reads packages/backend/.env — the legacy dev mode).
1. Resolution order: config.json in data dir wins; falls back to .env if data-dir is empty.
1. On first .env-only boot, log a deprecation hint with the recommended config.json location (don't auto-migrate; the wizard handles that).
1. Update all consumers to read through the new abstraction.
1. Add per-OS data dir resolution helper (uses node:os.homedir() + platform branch).
## Decisions resolved during grooming (2026-05-31)
- config.json shape: nested ({ notion: { apiKey }, github: { token }, server: { port }, ... }) — groups for the wizard's per-section UX and per-task-backend selection.
- Data-dir creation: eager — DataDirConfigSource creates the data dir on first instantiation.
- write(partial) semantics: deep-merge with existing JSON (caller passes a diff; read → merge → write). Add a test that writing one section leaves the others untouched.
## Acceptance criteria
### 🤖 Automated tests
ConfigSource interface + two concrete implementations
Per-OS data dir resolution helper with unit tests covering Windows / macOS / Linux
Resolution order: data-dir config.json wins, falls back to .env
All existing env var consumers (NOTION_API_KEY, GITHUB_TOKEN, GITHUB_REPO, PORT, DB_PATH, SESSIONS_DIR, AUTO_REVIEW, AUTO_REVIEW_CONCURRENCY) routed through the new abstraction
.env-only boot logs a deprecation hint with the recommended data-dir path (no auto-migration)
Schema validation: reject config.json with unknown top-level fields or wrong-typed values, exit cleanly with an actionable error message
Existing dev workflow (npm run dev reading .env) continues to work unchanged
## Files / paths affected
- packages/backend/src/config.ts (or new packages/backend/src/config/ module)
- All current process.env.* readers across the backend
- packages/backend/src/__tests__/ — new unit tests
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/config.ts`
```
import { getSecret } from './security/secrets';
import type { NonMilestoneSourceConfig } from './tasks/TaskBackend';

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
  taskSource: 'notion' | 'yaml' | 'jira'; // honored by getTaskBackend(projectId)
  gitMode: 'github' | 'local-only'; // 'github' (default) or 'local-only' (no GitHub remote)
  autoLaunchEnabled: boolean; // per-project toggle for the AutoLauncher
  autoLaunchMilestoneId: string | null; // milestone the AutoLauncher polls; null = first milestone
  autoMergeEnabled: boolean; // per-project toggle for the AutoMerger
  milestoneBranching?: 'two_tier' | 'flat' | null; // NULL/undefined = fall back to corporate-mode default
  nonMilestoneSourceConfig?: NonMilestoneSourceConfig | null; // config for the non-milestone task pool
  dataResidencyConfirmed: boolean; // ZDR attestation — user confirms Anthropic ZDR is enabled
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
  notionApiKey: getSecret('NOTION_API_KEY') ?? '',
  sqlitePath: process.env.DB_PATH ?? './dashboard.db',
  port: Number(process.env.PORT ?? 3000),
  projectDir: normalizePath(process.env.PROJECT_DIR ?? process.cwd()),
  claudePath: resolveClaudePath(),
  maxConcurrentCodeSessions: Number(
    process.env.MAX_CONCURRENT_CODE_SESSIONS ?? 20,
  ),
  anthropicApiKey: getSecret('ANTHROPIC_API_KEY') ?? '',
};

export const GITHUB_TOKEN = getSecret('GITHUB_TOKEN') ?? '';
export const GITHUB_REPO = process.env.GITHUB_REPO ?? ''; // "owner/repo"

// ── Jira integration ─────────────────────────────────────────────────────────
export const JIRA_HOST = process.env.JIRA_HOST ?? ''; // e.g. https://mycompany.atlassian.net
export const JIRA_TOKEN = getSecret('JIRA_TOKEN') ?? ''; // API token or PAT
export const JIRA_EMAIL = process.env.JIRA_EMAIL ?? ''; // email for basic auth (optional)

export const AUTO_REVIEW_ENABLED = process.env.AUTO_REVIEW !== 'false';
export const AUTO_REVIEW_CONCURRENCY = Number(
  process.env.AUTO_REVIEW_CONCURRENCY ?? 1,
);

// ── Session Bash output / timeout caps ───────────────────────────────────────
// Single source for both CLI (spawn) and API (Agent SDK) mode.
// Set on process.env so spawned sessions inherit without explicit env override.
export const BASH_MAX_OUTPUT_LENGTH = Number(
  process.env.BASH_MAX_OUTPUT_LENGTH ?? 30000,
);
export const BASH_DEFAULT_TIMEOUT_MS = Number(
  process.env.BASH_DEFAULT_TIMEOUT_MS ?? 300000,
);
process.env.BASH_MAX_OUTPUT_LENGTH = String(BASH_MAX_OUTPUT_LENGTH);
process.env.BASH_DEFAULT_TIMEOUT_MS = String(BASH_DEFAULT_TIMEOUT_MS);

export const ALLOWED_TOOLS = [
  'Bash(git:*)',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(node:*)',
  'Bash(tsc:*)',
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
];

function hydrateProject(p: {
  id: string;
  name: string;
  projectDir: string;
  contextUrl: string | null;
  githubRepo: string | null;
  taskSource: 'notion' | 'yaml' | 'jira';
  gitMode: 'github' | 'local-only';
  autoLaunchEnabled: boolean;
  autoLaunchMilestoneId: string | null;
  autoMergeEnabled: boolean;
  milestoneBranching: 'two_tier' | 'flat' | null;
  nonMilestoneSourceConfig: NonMilestoneSourceConfig | null;
  dataResidencyConfirmed: boolean;
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
    milestoneBranching: p.milestoneBranching,
    nonMilestoneSourceConfig: p.nonMilestoneSourceConfig,
    dataResidencyConfirmed: p.dataResidencyConfirmed,
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
  max_revie
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
- **Active Task Board** (Notion): https://www.notion.so/bbf9710c17474e3d97ed768b30a69ea1

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
- **M3 — Polish & Public Release**: https://www.notion.so/ca4d62a52c1a468bb23f2419dc8cc94b — ✅ Done (2026-04-27)
- **M4 — Stabilize for Full-Auto**: https://www.notion.so/58383a0cf4424fa3a23223eebee97459 — ✅ Done (2026-05-22)
- **M5 — Privacy, Bit-rot & UX Polish**: https://www.notion.so/2932df9453ea47d7827b8c17758d77d8 — ✅ Done (2026-05-26)
- **M6 — Enterprise Adoption Readiness**: https://www.notion.so/3edf1af401744a158c0e116810a8ce07 — ✅ Done (2026-05-31)
- **M7 — GitHub Task Source + Easy Install + Orchestrator Stabilization**: https://www.notion.so/bbf9710c17474e3d97ed768b30a69ea1 — 🔲 Active

## Notes

- Current phase: **M7 — GitHub Task Source + Easy Install + Orchestrator Stabilization**
- Filter the active task board to `💻 Code` type tasks unless instructed otherwise.