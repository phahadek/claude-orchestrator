# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Exempt orchestrator bot commits from attribution_missing audit
- **Notion task**: https://www.notion.so/Exempt-orchestrator-bot-commits-from-attribution_missing-audit-36d22f9152f381878eaafe3b67049cc1
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\49d5534b-cc2c-4bdb-a190-7ef0fd8f3e04`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\49d5534b-cc2c-4bdb-a190-7ef0fd8f3e04`).

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
CommitAttributionWatcher fires attribution_missing on commits that have no AI-Authored-By: trailer. The orchestrator's own autofix bot intentionally commits without the trailer (it's tooling, not LLM work). Skip the violation when the commit author matches the bot identity.
## Dependencies
None. Single-file fix.
## Context
### Verified false-positive (2026-05-27)
From the M6 gate sweep audit-log inspection:
```javascript
2026-05-27T16:00:53.088Z | attribution_missing | {"sha":"32434059e4bcdbf4aefbced8eff619645e80ed74","pr_number":400,"repo":"phahadek/claude-orchestrator"}
```
SHA 32434059... is in .git-blame-ignore-revs with the marker # chore: apply autofix [orchestrator] — i.e., it's a claude-orchestrator bot commit produced by runAutofix in packages/backend/src/session/autofix-runner.ts:124-128. That commit intentionally has no AI-Authored-By: trailer because the orchestrator-bot identity is system, not ai.
Three audit entries were written for SHA 32434059... on PR #400 alone. Roughly half of the 11 historical attribution_missing entries trace to bot commits, not session commits.
### What changes
CommitAttributionWatcher.ts: before classifying a commit as attribution_missing, check whether the commit's author.email matches the orchestrator-bot identity (bot@claude-code.internal, set by autofix-runner.ts:16-21). If so, skip the audit emit entirely — the bot's commits are neither AI-authored nor human-authored; they're tooling.
Concrete change:
```typescript
const ORCHESTRATOR_BOT_EMAIL = 'bot@claude-code.internal';

// Inside the existing per-commit loop, before the recordEvent({event_type: 'attribution_missing', ...}) call:
if (commit.author?.email === ORCHESTRATOR_BOT_EMAIL) {
  continue;  // tooling, not authored work
}
```
Export ORCHESTRATOR_BOT_EMAIL from autofix-runner.ts so the constant is single-sourced. If the bot email changes later, both call sites move together.
### Coordination with the audit-event-types task
If the companion task ("Add missing audit_log event types: commit and status_updated") ships first or in parallel, it will introduce a commit event emitted for every inspected commit. Bot commits should be emitted with actor_type: 'system' (not 'ai' or 'human') regardless of trailer presence. This task only governs the attribution_missing audit; the per-commit commit event still fires for bot commits with actor_type='system'.
### Out of scope
- Retroactively cleaning up historical false-positive attribution_missing entries.
- Recognizing other bot identities (GitHub Actions, dependabot, etc.) — only the orchestrator-bot identity is special-cased here.
- Changing the trailer policy itself.
## Acceptance criteria
### 🤖 Automated tests
- tsc --noEmit passes for both packages
- Unit test: CommitAttributionWatcher inspecting a commit authored by bot@claude-code.internal with no AI-Authored-By: trailer does NOT write an attribution_missing audit entry
- Unit test: same watcher inspecting a commit authored by bot@claude-code.internal with the trailer present (hypothetical) also does not write an attribution_missing audit entry (consistent skip)
- Unit test: a session-authored commit (any email ≠ the bot's) without the trailer still writes attribution_missing (regression coverage)
- Unit test: a session-authored commit with the trailer still writes no attribution_missing (regression coverage)
- ORCHESTRATOR_BOT_EMAIL is exported from autofix-runner.ts and imported — not duplicated — in CommitAttributionWatcher.ts
## Files / paths affected
- packages/backend/src/github/CommitAttributionWatcher.ts (update — add bot-author exemption)
- packages/backend/src/session/autofix-runner.ts (update — export ORCHESTRATOR_BOT_EMAIL)
- packages/backend/src/github/CommitAttributionWatcher.test.ts (update — add the bot-exemption test cases)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/github/CommitAttributionWatcher.ts`
```
import { recordEvent } from '../audit/AuditLog';
import { setPauseReason } from '../db/queries';
import type { GitHubClient } from './GitHubClient';

/** Matches the AI-Authored-By trailer in a commit message. */
export const AI_TRAILER_REGEX = /^AI-Authored-By:/m;

export interface CommitInfo {
  sha: string;
  message: string;
}

export interface AttributionCheckResult {
  checked: number;
  missing: number;
  paused: boolean;
}

/**
 * Check that all commits in a PR carry the AI-Authored-By trailer.
 * In corporate mode, missing trailers pause the PR and are audit-logged.
 * In non-corporate mode, only audit-logs (no pause).
 *
 * Returns a summary of what was found.
 */
export async function checkCommitAttribution(
  client: GitHubClient,
  repo: string,
  prNumber: number,
  sessionId: string,
  projectId: string | null,
  taskId: string | null,
  isCorporateMode: boolean,
): Promise<AttributionCheckResult> {
  let commits: CommitInfo[];
  try {
    commits = await client.getCommitsForPR(repo, prNumber);
  } catch (err) {
    console.warn(
      `[CommitAttributionWatcher] failed to fetch commits for PR #${prNumber} in ${repo}: ${(err as Error).message}`,
    );
    return { checked: 0, missing: 0, paused: false };
  }

  const missingTrailer = commits.filter(
    (c) => !AI_TRAILER_REGEX.test(c.message),
  );

  if (missingTrailer.length === 0) {
    return { checked: commits.length, missing: 0, paused: false };
  }

  for (const commit of missingTrailer) {
    recordEvent({
      event_type: 'attribution_missing',
      actor_type: 'ai',
      actor_id: sessionId,
      project_id: projectId,
      task_id: taskId,
      payload: { sha: commit.sha, pr_number: prNumber, repo },
    });
  }

  if (isCorporateMode) {
    setPauseReason(prNumber, repo, 'attribution_missing');
    return {
      checked: commits.length,
      missing: missingTrailer.length,
      paused: true,
    };
  }

  return {
    checked: commits.length,
    missing: missingTrailer.length,
    paused: false,
  };
}

```

### `packages/backend/src/session/autofix-runner.ts`
```
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import yaml from 'js-yaml';

interface OrchestratorYml {
  autofix?: string[];
}

export interface AutofixResult {
  success: boolean;
  commitSha?: string;
  summary: string;
}

const BOT_GIT_ENV = {
  GIT_AUTHOR_NAME: 'claude-orchestrator',
  GIT_AUTHOR_EMAIL: 'bot@claude-code.internal',
  GIT_COMMITTER_NAME: 'claude-orchestrator',
  GIT_COMMITTER_EMAIL: 'bot@claude-code.internal',
};

export function loadAutofixCommands(projectDir: string): string[] {
  const ymlPath = path.join(projectDir, '.claude-orchestrator.yml');
  if (!fs.existsSync(ymlPath)) return [];
  try {
    const raw = fs.readFileSync(ymlPath, 'utf-8');
    const parsed = yaml.load(raw) as OrchestratorYml | null;
    if (!parsed || !Array.isArray(parsed.autofix)) return [];
    return parsed.autofix.filter(
      (cmd): cmd is string => typeof cmd === 'string',
    );
  } catch (err) {
    console.warn(`[autofix-runner] failed to parse ${ymlPath}: ${err}`);
    return [];
  }
}

function spawnCmd(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('close', (code) => resolve({ exitCode: code ?? 1, stdout: out }));
  });
}

function spawnShell(
  cmd: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
  log: (msg: string) => void,
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, { shell: true, cwd: opts.cwd, env: opts.env });
    proc.stdout?.on('data', (d: Buffer) => log(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => log(d.toString()));
    proc.on('close', (code) => resolve({ exitCode: code ?? 1 }));
  });
}

async function isWorktreeDirty(cwd: string): Promise<boolean> {
  const { stdout } = await spawnCmd('git', ['status', '--porcelain'], { cwd });
  return stdout.trim().length > 0;
}

async function getHeadSha(cwd: string): Promise<string> {
  const { stdout } = await spawnCmd('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

export async function runAutofix(
  worktreePath: string,
  projectDir: string,
  commands: string[],
  log: (msg: string) => void,
): Promise<AutofixResult> {
  if (commands.length === 0) {
    return { success: true, summary: 'no autofix commands configured' };
  }

  const failures: string[] = [];

  for (const cmd of commands) {
    log(`[autofix] running: ${cmd}\n`);
    const { exitCode } = await spawnShell(cmd, { cwd: worktreePath }, log);
    if (exitCode !== 0) {
      const msg = `command exited with code ${exitCode}: ${cmd}`;
      log(`[autofix] WARN: ${msg}\n`);
      failures.push(msg);
    }
  }

  const dirty = await isWorktreeDirty(worktreePath);
  if (!dirty) {
    const summary =
      failures.length > 0
        ? `autofix commands ran but produced no diff (failures: ${failures.join('; ')})`
        : 'autofix commands produced no diff';
    return { success: failures.length === 0, summary };
  }

  // Commit the diff with bot identity
  const env = { ...process.env, ...BOT_GIT_ENV };

  const addResult = await spawnCmd('git', ['add', '-A'], {
    cwd: worktreePath,
    env,
  });
  if (addResult.exitCode !== 0) {
    const msg = `git add -A failed (exit ${addResult.exitCode})`;
    log(`[autofix] ERROR: ${msg}\n`);
    failures.push(msg);
  }

  const commitResult = await spawnCmd(
    'git',
    ['commit', '-m', 'chore: apply autofix [orchestrator]'],
    { cwd: worktreePath, env },
  );
  if (commitResult.exitCode !== 0) {
    const msg = `git commit failed (exit ${commitResult.exitCode})`;
    log(`[autofix] ERROR: ${msg}\n`);
    return {
      success: false,
      summary: [...failures, msg].join('; '),
    };
  }

  const sha = await getHeadSha(worktreePath);
  log(`[autofix] committed ${sha}\n`);

  const pushResult = await spawnCmd('git', ['push', 'origin', 'HEAD'], {
    cwd: worktreePath,
    env,
  });
  if (pushResult.exitCode !== 0) {
    const msg = `git push failed (exit ${pushResult.exitCode})`;
    log(`[autofix] ERROR: ${msg}\n`);
    failures.push(msg);
  }

  // Append SHA to .git-blame-ignore-revs at project root
  try {
    const blameIgnorePath = path.join(projectDir, '.git-blame-ignore-revs');
    fs.appendFileSync(
      blameIgnorePath,
      `${sha} # chore: apply autofix [orchestrator]\n`,
    );
    log(`[autofix] appended ${sha} to .git-blame-ignore-revs\n`);
  } catch (err) {
    log(`[autofix] WARN: failed to append to .git-blame-ignore-revs: ${err}\n`);
  }

  const success = failures.length === 0;
  const summary = success
    ? `autofix committed ${sha}`
    : `autofix committed ${sha} with failures: ${failures.join('; ')}`;

  return { success, commitSha: sha, summary };
}

```

### `packages/backend/src/github/CommitAttributionWatcher.test.ts`
```
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AuditLog before importing the watcher
vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../db/queries', () => ({
  setPauseReason: vi.fn(),
}));

import {
  checkCommitAttribution,
  AI_TRAILER_REGEX,
} from './CommitAttributionWatcher';
import { recordEvent } from '../audit/AuditLog';
import { setPauseReason } from '../db/queries';
import type { GitHubClient } from './GitHubClient';

function makeClient(
  commits: Array<{ sha: string; message: string }>,
): GitHubClient {
  return {
    getCommitsForPR: vi.fn().mockResolvedValue(commits),
  } as unknown as GitHubClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AI_TRAILER_REGEX', () => {
  it('matches a valid AI-Authored-By trailer', () => {
    expect(
      AI_TRAILER_REGEX.test(
        'feat: add thing\n\nAI-Authored-By: claude-sonnet-4-6 (session: abc)',
      ),
    ).toBe(true);
  });

  it('does not match commits without the trailer', () => {
    expect(
      AI_TRAILER_REGEX.test('feat: add thing\n\nCo-Authored-By: human'),
    ).toBe(false);
  });
});

describe('checkCommitAttribution()', () => {
  it('returns missing=0 when all commits have the trailer', async () => {
    const client = makeClient([
      {
        sha: 'aaa',
        message: 'feat: x\n\nAI-Authored-By: claude-sonnet-4-6 (session: s1)',
      },
    ]);
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      1,
      's1',
      null,
      null,
      false,
    );
    expect(result.checked).toBe(1);
    expect(result.missing).toBe(0);
    expect(result.paused).toBe(false);
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
  });

  it('records attribution_missing to the audit log when a trailer is absent', async () => {
    const client = makeClient([
      { sha: 'bbb', message: 'feat: no trailer here' },
    ]);
    await checkCommitAttribution(
      client,
      'owner/repo',
      2,
      'session-xyz',
      'proj-1',
      'task-1',
      false,
    );
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'attribution_missing',
        actor_type: 'ai',
        actor_id: 'session-xyz',
        payload: expect.objectContaining({
          sha: 'bbb',
          pr_number: 2,
          repo: 'owner/repo',
        }),
      }),
    );
    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
  });

  it('pauses in corporate mode when a trailer is absent', async () => {
    const client = makeClient([
      { sha: 'ccc', message: 'chore: no attribution' },
    ]);
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      3,
      's1',
      null,
      null,
      true,
    );
    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      3,
      'owner/repo',
      'attribution_missing',
    );
    expect(result.paused).toBe(true);
  });

  it('does NOT pause in non-corporate mode even when trailer is absent', async () => {
    const client = makeClient([{ sha: 'ddd', message: 'fix: oops' }]);
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      4,
      's1',
      null,
      null,
      false,
    );
    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
    expect(result.paused).toBe(false);
    expect(result.missing).toBe(1);
  });

  it('handles fetch errors gracefully', async () => {
    const client = {
      getCommitsForPR: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as GitHubClient;
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      5,
      's1',
      null,
      null,
      false,
    );
    expect(result.checked).toBe(0);
    expect(result.missing).toBe(0);
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
  });

  it('only records missing for commits without the trailer (mixed batch)', async () => {
    const client = makeClient([
      {
        sha: 'e1',
        message:
          'feat: good\n\nAI-Authored-By: claude-sonnet-4-6 (session: s1)',
      },
      { sha: 'e2', message: 'chore: bad — no trailer' },
    ]);
    const result = await checkCommitAttribution(
      client,
      'owner/repo',
      6,
      's1',
      null,
      null,
      false,
    );
    expect(result.checked).toBe(2);
    expect(result.missing).toBe(1);
    expect(vi.mocked(recordEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ sha: 'e2' }),
      }),
    );
  });
});

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