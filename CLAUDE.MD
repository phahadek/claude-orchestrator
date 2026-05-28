# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Autofix bot still commits CLAUDE.MD; reactive pollution-check is intermittent — add proactive cleanup in autofix-runner
- **Notion task**: https://www.notion.so/Autofix-bot-still-commits-CLAUDE-MD-reactive-pollution-check-is-intermittent-add-proactive-cleanu-36e22f9152f381d79fc6d11f31745636
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\f066b523-06f3-4407-9109-9d01d39b24ce`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\f066b523-06f3-4407-9109-9d01d39b24ce`).

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
The "Autofix bot must not commit CLAUDE.md changes" task (merged as d141b57) and the "Always run autofix on every PR push" task (merged as 5e0f8f9) did not actually prevent CLAUDE.MD from leaking into PRs. They wired up a reactive cleanup layer (runFilePollutionCheck invoked after runAutofix produces a commit) but left the autofix bot's git add -A free to sweep CLAUDE.MD into its commit. The reactive cleanup is intermittent in production — 1 of the last 4 PRs had the auto-revert fire; 2 needed manual session-side restoration; 1 shipped contaminated.
The fix is to make runAutofix proactively exclude HARD_BANNED_FILES from the worktree before invoking format/lint commands, so the autofix commit never contains them in the first place. The existing reactive runFilePollutionCheck stays as defense-in-depth.
## Dependencies
- Fix: Autofix bot must not commit CLAUDE.md changes (✅ Done — d141b57) — added the post-autofix runFilePollutionCheck call but did not prevent autofix from staging CLAUDE.MD.
- Always run autofix on every PR push (✅ Done — 5e0f8f9) — ensured the reactive cleanup runs on re-reviews too, but the underlying intermittency remains.
## Context
### Direct production evidence — PR #423 (c4ff35b)
The contaminated commit is c4ff35b feat: autofix-dedup-db-persistence on dev. Its feature branch had d680003 (feature commit) and 47023f0 (autofix commit that included CLAUDE.MD). The PR was open from 14:31:21 to 14:34:54 UTC.
Audit log (audit_log table) for PR #423 in that window:

No file_pollution_checked event ever fired at head_sha 47023f0 (the autofix commit). Compare to PR #421 which DID work correctly:

For PR #421, the second check fired ~22 seconds after the first and correctly detected CLAUDE.MD, triggering the revert. For PR #423, the equivalent second check never fired.
### Why the reactive cleanup is intermittent
The wiring in ReviewOrchestrator.runAutofixPipeline (ReviewOrchestrator.ts:185-273) gates the pollution-check on THREE conditions, all of which must hold:
```typescript
if (result.commitSha) {                           // (1) autofix produced a commit
  addAutofixSha(prNumber, repo, result.commitSha);
  if (prRow?.session_id && result.touchedFiles?.length) {
    this.sessionManager.addToRevertLock(...);
  }
  if (this.github) {                              // (2) GitHub client is wired
    const pollutionResult = await runFilePollutionCheck({...});  // (3) and the call itself succeeds
  }
}
```
Inside runFilePollutionCheck (filePollutionCheck.ts:104-181), the entire body is wrapped in a try/catch that only console.warns on failure — NO audit event is emitted on the failure path. So when github.getPRFiles() or github.fetchPR() throws (rate limit, transient network error, eventual-consistency lag where GitHub hasn't yet indexed the autofix push, etc.), the failure is silent and unrecoverable for that PR.
Candidate causes for PR #423's specific failure, all consistent with the audit-log evidence:
- Most likely: github.getPRFiles(repo, 423) threw transiently when runAutofixPipeline called runFilePollutionCheck after autofix's push, swallowed by the catch (e) block at filePollutionCheck.ts:178. No retry.
- Possible: GitHub's PR file-list API returned a stale (pre-autofix) file list while fetchPR returned an equally stale head SHA (the same head_sha the inline check already saw), and a duplicate banned_files_found: 0 event was emitted but the log lookup matched on a different sha so it appears missing. The 14:31:41 event at head_sha=d680003… is suspicious for this reason. Either way, no protection fired.
- Possible: runAutofixPipeline never executed for the autofix-push event because the push_detected server handler had a pendingReReviews guard that swallowed it. Worth verifying.
### Why the architecture is fragile by design
The current design accepts that the autofix bot will commit CLAUDE.MD and relies on a downstream reactive layer to clean it up. This doubles the surface area for failure:
- Autofix runs prettier on the orchestrator-injected CLAUDE.MD → reformatted content is on disk.
- git add -A stages the change.
- Bot commits with the staged change.
- Bot pushes the commit to origin.
- All of the above is presumed-correct contamination. Only step 6+ — the reactive runFilePollutionCheck — stands between the contaminated push and a contaminated merge.
Any silent failure in step 6 (GitHub API hiccup, race with auto-merge, etc.) ships contamination. Auto-merge can fire within seconds of the autofix push, leaving little time for the pollution check to detect and revert before the PR is gone.
### Pattern across recent PRs

1 of 4 recent PRs had the auto-revert work. The other 3 either got manual session intervention or shipped broken. This is not a one-off bug — the reactive layer is structurally unreliable.
## Approach (locked)
Add proactive HARD_BANNED_FILES cleanup inside runAutofix, executed before the configured format/lint commands run. The reactive runFilePollutionCheck stays as defense-in-depth.
### Concrete changes
1. packages/backend/src/session/autofix-runner.ts — inside runAutofix, between the early-return on commands.length === 0 (line 92-94) and the commands loop (line 98), add a cleanup step:
1. After format/lint commands run, the worktree no longer contains the orchestrator-injected versions of HARD_BANNED files. git add -A cannot stage what is not there. The autofix commit is clean by construction.
1. The existing runFilePollutionCheck in runAutofixPipeline stays in place as a backstop — catches anything the proactive layer somehow misses (e.g. a future banned file added to HARD_BANNED_FILES but not yet seen by the proactive layer).
### Observability improvements (in scope)
- Add recordEvent({event_type: 'autofix_banned_file_stripped', ...}) for each file the proactive cleanup removes/restores. Currently invisible.
- Add recordEvent({event_type: 'file_pollution_check_failed', ...}) inside the catch (e) block at filePollutionCheck.ts:178 so silent failures of the reactive layer become observable.
### Why this aligns with the existing protection design
- HARD_BANNED_FILES (PRFileValidator.ts:4) remains the single source of truth. The proactive layer in runAutofix imports and reads from the same constant; it does not duplicate the list.
- The existing reactive validatePRFiles + revertBannedFiles + runFilePollutionCheck pipeline is unchanged.
- Two layers using one source of truth: proactive prevention in the autofix bot path, reactive cleanup downstream as a backstop.
- Failure of either layer alone no longer ships contamination.
### Why this is different from the originally-proposed-and-rejected approach
The original "Autofix bot must not commit CLAUDE.md" task discussion considered a similar proactive cleanup but rejected it on alignment grounds: "hardcodes CLAUDE.md filename knowledge inside autofix-runner; invents a parallel protection mechanism." Both objections are addressed here:
1. No hardcoding: import HARD_BANNED_FILES from PRFileValidator. The list stays the single source of truth.
1. Not a parallel mechanism: same source-of-truth used proactively instead of reactively. The reactive layer continues to exist; we are adding belt to the suspenders, not replacing them.
The rejection was correct as a critique of "replace the reactive layer with a special-case proactive cleanup." It does not apply to "add a proactive layer that uses the same source-of-truth, alongside the existing reactive layer."
## Acceptance criteria
### 🤖 Automated tests
All tests follow the existing vitest + module-mock pattern. No real git, prettier, or file system.
1. PRFileValidator.test.ts (extended): isHardBanned is exported and continues to match its existing semantics (covered by existing tests; this is a visibility change, not a behavior change).
1. autofix-runner.test.ts (extended): after git add -A runs, runAutofix invokes git diff --cached --name-only to enumerate staged paths, then git restore --staged -- <path> for each staged path that matches isHardBanned. Asserted via call-order on the mocked spawn.
1. autofix-runner.test.ts: when git diff --cached --name-only returns a CLAUDE.MD path (uppercase MD), git restore --staged -- CLAUDE.MD is invoked with that exact case (not a lowercase variant). Verifies the case-handling via real staged paths.
1. autofix-runner.test.ts: when git diff --cached --name-only returns a commit-msg.draft path (matches HARD_BANNED_PATTERNS, not HARD_BANNED_FILES), git restore --staged -- commit-msg.draft is invoked. Verifies pattern coverage.
1. autofix-runner.test.ts: when no staged paths match isHardBanned, no git restore --staged calls are made and the run proceeds normally to commit.
1. autofix-runner.test.ts: when the un-stage step leaves nothing staged (banned files were the only changes), the commit step is skipped and the function returns success: true with a summary indicating no commit was made.
1. autofix-runner.test.ts: when staged paths include BOTH banned and clean files, only banned paths are un-staged, the commit runs, and the final commit's git diff --name-only HEAD~1 HEAD does NOT list the banned files.
1. autofix-runner.test.ts: the worktree is NOT modified by runAutofix after the un-stage step — no calls to fs.unlink, fs.writeFileSync, or git restore --worktree for banned files.
1. autofix-runner.test.ts: a recordEvent({event_type: 'autofix_banned_file_unstaged', ...}) audit-log entry is emitted for each banned file the un-stage step acts on. Mocked recordEvent.
1. autofix-runner.test.ts: existing tests (bot identity on commit, push, blame-ignore append, sync-to-origin) continue to pass.
1. filePollutionCheck.test.ts (extended): when getPRFiles throws (mocked), recordEvent({event_type: 'file_pollution_check_failed', ...}) is emitted with the error message before the function returns. Currently nothing is recorded on that path — this regression test guards against future silent failures.
1. Existing ReviewOrchestrator.test.ts tests for the post-autofix pollution check continue to pass — the reactive layer's behavior is unchanged.
## Files / paths affected
- packages/backend/src/github/PRFileValidator.ts — export the existing isHardBanned helper (currently a private function at line 20).
- packages/backend/src/session/autofix-runner.ts — between git add -A and git commit, enumerate staged paths via git diff --cached --name-only, filter via isHardBanned, git restore --staged -- each match; skip commit if nothing remains staged; emit autofix_banned_file_unstaged audit events.
- packages/backend/src/session/filePollutionCheck.ts — emit file_pollution_check_failed audit event inside the silent-failure catch (e) block (filePollutionCheck.ts:178).
- Corresponding *.test.ts files.
## Implementation notes
> To be filled in during/after implementation.
## Rollback evidence
The contaminated commit c4ff35b was rolled back on dev as commit 9b55da2 fix: restore canonical CLAUDE.MD after autofix contamination in c4ff35b (pushed directly to dev per maintainer instruction). The 305-line canonical CLAUDE.MD is now the dev state. This task addresses the underlying failure mode that allowed the contamination.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/github/PRFileValidator.ts`
```
import ignore from 'ignore';
import path from 'path';

export const HARD_BANNED_FILES: readonly string[] = [
  'CLAUDE.md',
  '.commit-msg',
  '.commit_msg',
];

// Patterns (case-insensitive) that match commit-message scratch files regardless of extension.
// Catches commit-msg.txt, commit_msg.txt, commit-msg.draft, commit_msg.md, etc.
export const HARD_BANNED_PATTERNS: readonly RegExp[] = [/^commit[-_]msg\..+$/i];

export interface PRFileValidationResult {
  valid: boolean;
  bannedFiles: string[];
  reason?: 'hard_banned' | 'gitignore_match' | 'mixed';
}

function isHardBanned(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (HARD_BANNED_FILES.some((f) => f.toLowerCase() === base)) return true;
  const basename = path.basename(filePath);
  return HARD_BANNED_PATTERNS.some((p) => p.test(basename));
}

export function validatePRFiles(
  changedFiles: string[],
  gitignoreSources: Array<{ dir: string; content: string }>,
): PRFileValidationResult {
  const hardBanned: string[] = [];
  const gitignoreMatched: string[] = [];

  // Build per-directory ignore matchers from gitignore sources
  const matchers: Array<{ dir: string; ig: ReturnType<typeof ignore> }> =
    gitignoreSources.map(({ dir, content }) => ({
      dir: dir === '' ? '' : dir.replace(/\\/g, '/').replace(/\/$/, ''),
      ig: ignore().add(content),
    }));

  for (const file of changedFiles) {
    const normalised = file.replace(/\\/g, '/');

    if (isHardBanned(normalised)) {
      hardBanned.push(file);
      continue;
    }

    // Check each gitignore matcher: the file must be under the matcher's dir
    // for that matcher's patterns to apply.
    let matched = false;
    for (const { dir, ig } of matchers) {
      let relative: string;
      if (dir === '') {
        relative = normalised;
      } else {
        if (!normalised.startsWith(dir + '/')) continue;
        relative = normalised.slice(dir.length + 1);
      }
      if (ig.ignores(relative)) {
        matched = true;
        break;
      }
    }

    if (matched) {
      gitignoreMatched.push(file);
    }
  }

  const bannedFiles = [...hardBanned, ...gitignoreMatched];
  if (bannedFiles.length === 0) {
    return { valid: true, bannedFiles: [] };
  }

  let reason: PRFileValidationResult['reason'];
  if (hardBanned.length > 0 && gitignoreMatched.length > 0) {
    reason = 'mixed';
  } else if (hardBanned.length > 0) {
    reason = 'hard_banned';
  } else {
    reason = 'gitignore_match';
  }

  return { valid: false, bannedFiles, reason };
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
  /** HEAD SHA after the local branch was synced to origin via fetch + reset --hard. */
  syncedTo?: string;
  /** Files included in the autofix commit (from git diff --name-only HEAD~1 HEAD). */
  touchedFiles?: string[];
  summary: string;
}

export const ORCHESTRATOR_BOT_EMAIL = 'bot@claude-code.internal';

const BOT_GIT_ENV = {
  GIT_AUTHOR_NAME: 'claude-orchestrator',
  GIT_AUTHOR_EMAIL: ORCHESTRATOR_BOT_EMAIL,
  GIT_COMMITTER_NAME: 'claude-orchestrator',
  GIT_COMMITTER_EMAIL: ORCHESTRATOR_BOT_EMAIL,
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

  // Collect the files included in the commit so callers can populate _revertLock
  let touchedFiles: string[] | undefined;
  try {
    const diffResult = await spawnCmd(
      'git',
      ['diff', '--name-only', 'HEAD~1', 'HEAD'],
      { cwd: worktreePath },
    );
    touchedFiles = diffResult.stdout.split('\n').filter(Boolean);
  } catch {
    // best-effort
  }

  // Capture current branch before pushing so we can sync to it afterward
  const { stdout: branchRaw } = await spawnCmd(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: worktreePath },
  );
  const branch = branchRaw.trim();

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

  // Sync local branch to origin after push so subsequent git operations see
  // a consistent state (no local/origin divergence).
  let syncedTo: string | undefined;
  if (failures.length === 0 && branch && branch !== 'HEAD') {
    const fetchResult = await spawnCmd('git', ['fetch', 'origin', branch], {
      cwd: worktreePath,
    });
    if (fetchResult.exitCode === 0) {
      const resetResult = await spawnCmd(
        'git',
        ['reset', '--hard', `origin/${branch}`],
        { cwd: worktreePath },
      );
      if (resetResult.exitCode === 0) {
        const headResult = await spawnCmd('git', ['rev-parse', 'HEAD'], {
          cwd: worktreePath,
        });
        syncedTo = headResult.stdout.trim() || undefined;
        log(`[autofix] synced to origin/${branch} at ${syncedTo}\n`);
      }
    }
  }

  const success = failures.length === 0;
  const summary = success
    ? `autofix committed ${sha}`
    : `autofix committed ${sha} with failures: ${failures.join('; ')}`;

  return { success, commitSha: sha, syncedTo, touchedFiles, summary };
}

```

### `packages/backend/src/session/filePollutionCheck.ts`
```
import fs from 'fs';
import path from 'path';
import { validatePRFiles } from '../github/PRFileValidator';
import { revertBannedFiles } from '../github/PRFileReverter';
import { recordEvent } from '../audit/AuditLog';
import type { GitHubClient } from '../github/GitHubClient';

/** Walk a directory tree collecting all .gitignore files, root-first. */
export function collectGitignoreSources(
  rootDir: string,
): Array<{ dir: string; content: string }> {
  const results: Array<{ dir: string; content: string }> = [];
  function walk(dir: string): void {
    const rel = path.relative(rootDir, dir).replace(/\\/g, '/');
    const gitignorePath = path.join(dir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        results.push({
          dir: rel,
          content: fs.readFileSync(gitignorePath, 'utf8'),
        });
      } catch {
        // ignore unreadable
      }
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') {
        walk(path.join(dir, e.name));
      }
    }
  }
  walk(rootDir);
  return results;
}

export interface FilePollutionCheckOptions {
  github: GitHubClient;
  worktreePath: string;
  repo: string;
  prNumber: number;
  baseBranch: string;
  sessionId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  /** Called with the list of reverted file paths after a successful revert. */
  onReverted?: (files: string[]) => void;
  /** Register a sync promise so callers can await the revert completing before fetching the diff. */
  registerRevertSync?: (
    prNumber: number,
    repo: string,
    promise: Promise<void>,
  ) => void;
  /**
   * Loop guard: if the PR's current HEAD SHA equals this value, skip the
   * entire check. Used by the push-detected path in AgentSession to avoid
   * re-reverting our own orchestrator-revert commit.
   */
  lastRevertSha?: string | null;
}

export interface FilePollutionCheckResult {
  headSha: string | null;
  revertCommitSha: string | null;
}

/**
 * Fetch the PR's changed files, validate for banned/gitignored paths, and
 * revert any violations. Posts a GitHub comment when files are reverted.
 *
 * Used by both AgentSession (push-detected path) and ReviewOrchestrator
 * (post-autofix path) so that HARD_BANNED_FILES stays the single source of
 * truth for what must never appear in a PR diff.
 */
export async function runFilePollutionCheck(
  opts: FilePollutionCheckOptions,
): Promise<FilePollutionCheckResult> {
  const { github, worktreePath, repo, prNumber, baseBranch } = opts;
  const sessionId = opts.sessionId ?? null;
  const projectId = opts.projectId ?? null;
  const taskId = opts.taskId ?? null;

  // Fetch the current head SHA for the loop guard check.
  let headSha: string | null = null;
  try {
    const pr = await github.fetchPR(repo, prNumber);
    headSha = pr.headSha ?? null;
  } catch (e) {
    console.warn(
      `[filePollutionCheck] could not fetch head SHA for PR #${prNumber}: ${e}`,
    );
  }

  // Loop guard: skip if HEAD equals the last orchestrator-revert SHA.
  if (opts.lastRevertSha && headSha === opts.lastRevertSha) {
    return { headSha, revertCommitSha: null };
  }

  try {
    const changedFiles = await github.getPRFiles(repo, prNumber);
    const gitignoreSources = collectGitignoreSources(worktreePath);
    const validation = validatePRFiles(changedFiles, gitignoreSources);

    // Record that the validator ran — observable even when no violations found.
    recordEvent({
      event_type: 'file_pollution_checked',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: projectId,
      task_id: taskId,
      payload: {
        pr_number: prNumber,
        repo,
        head_sha: headSha,
        banned_files_found: validation.bannedFiles.length,
      },
    });

    if (validation.valid) return { headSha, revertCommitSha: null };

    // Register the sync promise BEFORE starting work so ReviewOrchestrator can await it.
    let resolveSyncPromise!: () => void;
    const syncPromise = new Promise<void>((r) => {
      resolveSyncPromise = r;
    });
    opts.registerRevertSync?.(prNumber, repo, syncPromise);

    let commitSha: string | null = null;
    let reverted: string[] = [];
    try {
      ({ commitSha, reverted } = await revertBannedFiles({
        worktreePath,
        baseBranch,
        bannedFiles: validation.bannedFiles,
        prNumber,
        repo,
      }));
    } finally {
      resolveSyncPromise();
    }

    if (commitSha === null || reverted.length === 0) {
      return { headSha, revertCommitSha: null };
    }

    opts.onReverted?.(reverted);

    recordEvent({
      event_type: 'file_pollution_reverted',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: projectId,
      task_id: taskId,
      payload: {
        files: reverted,
        pr_number: prNumber,
        commit_sha: commitSha,
      },
    });

    const fileList = reverted.map((f) => `- ${f}`).join('\n');
    void github
      .createIssueComment(
        repo,
        prNumber,
        `🔒 Orchestrator auto-reverted the following files from this PR:\n\n${fileList}`,
      )
      .catch((e) =>
        console.warn(`[filePollutionCheck] createIssueComment failed: ${e}`),
      );

    return { headSha, revertCommitSha: commitSha };
  } catch (e) {
    console.warn(`[filePollutionCheck] check failed for PR #${prNumber}: ${e}`);
    return { headSha, revertCommitSha: null };
  }
}

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