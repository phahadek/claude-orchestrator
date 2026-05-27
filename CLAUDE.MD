# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Extend scrubSecrets regex to T16 spec: GitHub OAuth variants, Slack, Bearer context
- **Notion task**: https://www.notion.so/Extend-scrubSecrets-regex-to-T16-spec-GitHub-OAuth-variants-Slack-Bearer-context-36d22f9152f3816d9dc1c7d3301be0db
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\8faf23d7-7df4-477e-9982-0a4b2bd47783`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\8faf23d7-7df4-477e-9982-0a4b2bd47783`).

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
The shipped scrubSecrets regex covers sk-ant-*, ghp_*, ntn_*, secret_* but is narrower than the T16 task spec called for. Extend it to cover all GitHub token variants (gho_, ghu_, ghr_, ghs_, ghi_), Slack tokens (xox[bpars]-), and add the Bearer-token context rule.
## Dependencies
None. Single-file regex extension + tests.
## Context
### What's missing today
packages/backend/src/security/scrubSecrets.ts:6 currently has:
```typescript
const SECRET_PATTERN = /\b(sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,}|secret_[A-Za-z0-9_-]{10,}|ntn_[A-Za-z0-9_-]{10,})\b/g;
```
T16 Secrets hardening called for:
- sk-ant-[A-Za-z0-9_-]+ (Anthropic) — ✅ shipped
- ntn_[A-Za-z0-9_-]+ (Notion external integrations) — ✅ shipped
- secret_[A-Za-z0-9_-]+ (Notion internal integrations) — ✅ shipped
- gh[poursi]_[A-Za-z0-9_-]+ (GitHub PATs: ghp_, gho_, ghu_, ghr_, ghs_, ghi_) — ⚠️ only ghp_ shipped
- xox[bpars]-[A-Za-z0-9-]+ (Slack — future-proof) — ❌ not shipped
- Bearer-token context rule: after literal Authorization: Bearer  (case-insensitive), scrub the next whitespace-delimited token regardless of shape — ❌ not shipped
### Verified gaps during the M6 gate sweep (2026-05-27)
Inline tests against the live regex:
- Bearer gho_abcdefghijklmnopqrst → NOT redacted (should be)
- Bearer ghu_abcdefghijklmnopqrst → NOT redacted (should be)
- ghp_* works as expected
### What changes
1. Extend the pattern alternation in scrubSecrets.ts:6:
1. Add Bearer-token context rule as a separate pre-step. The token shape is unknown; the context Authorization: Bearer  is what signals secrecy. Run this before the prefix-pattern replace so a Bearer-wrapped opaque token is redacted regardless of shape.
1. Expand tests in scrubSecrets.test.ts to cover the new patterns.
Order matters: Bearer first, then prefix patterns. A Bearer-wrapped prefixed token (e.g. Authorization: Bearer ghp_xxx) is redacted by the Bearer rule first; any plain-text mention of the same token elsewhere is still caught by the prefix rule.
### Out of scope
- Generic high-entropy detection — explicitly rejected in T16 design due to false positives on structured data (UUIDs, hashes, base64 chunks, etc.).
- AWS keys (AKIA[0-9A-Z]{16}) — referenced in some test fixtures but not in T16 spec; can be added later if needed.
- Rewriting historical session_events rows — forward-only; the M6 gate sweep already identified and deleted the one real historical leak (session_events.id = 24263).
## Acceptance criteria
### 🤖 Automated tests
- tsc --noEmit passes for both packages
- All six GitHub variants redact: scrubSecrets('token=ghp_abcdefghijklmnopqrst'), 'gho_...', 'ghu_...', 'ghr_...', 'ghs_...', 'ghi_...' each return 'token=[REDACTED]'
- All five Slack variants redact: 'xoxb-...', 'xoxp-...', 'xoxa-...', 'xoxr-...', 'xoxs-...'
- Bearer context rule: scrubSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def') returns 'Authorization: Bearer [REDACTED]'
- Bearer context rule case-insensitive: 'authorization: bearer xyz123abc' redacts
- Bearer context rule has no length minimum: 'Authorization: Bearer short' redacts to 'Authorization: Bearer [REDACTED]'
- Bearer + prefixed combo: 'Authorization: Bearer ghp_abcdefghijklmnopqrst' redacts to 'Authorization: Bearer [REDACTED]' (single redaction, not double)
- Existing tests (sk-ant, ntn_, secret_, ghp_, plain text, short partials) continue to pass
- New tests for nested object scrubbing call both rules
## Files / paths affected
- packages/backend/src/security/scrubSecrets.ts (update — extend SECRET_PATTERN, add BEARER_PATTERN)
- packages/backend/src/security/scrubSecrets.test.ts (update — add the cases above)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/security/scrubSecrets.ts`
```
/**
 * Secret patterns to redact. Pattern-only matching — no entropy heuristic.
 * Patterns: sk-ant-* (Anthropic), ghp_* (GitHub PAT), secret_* (generic), ntn_* (Notion).
 */
const SECRET_PATTERN =
  /\b(sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,}|secret_[A-Za-z0-9_-]{10,}|ntn_[A-Za-z0-9_-]{10,})\b/g;

const REDACTED = '[REDACTED]';

/**
 * Recursively traverse any JSON-serializable value and return a copy with
 * known secret patterns replaced. Primitives other than strings are returned
 * as-is. Cycles are not handled — callers must not pass circular references.
 */
export function scrubSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(SECRET_PATTERN, REDACTED) as T;
  }
  if (Array.isArray(value)) {
    return value.map(scrubSecrets) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = scrubSecrets(v);
    }
    return result as T;
  }
  return value;
}

```

### `packages/backend/src/security/scrubSecrets.test.ts`
```
import { describe, it, expect } from 'vitest';
import { scrubSecrets } from './scrubSecrets';

describe('scrubSecrets', () => {
  it('redacts sk-ant-* pattern in a flat string', () => {
    expect(scrubSecrets('key is sk-ant-api03-abc1234567890xyz')).toBe(
      'key is [REDACTED]',
    );
  });

  it('redacts ghp_* pattern in a flat string', () => {
    expect(scrubSecrets('token ghp_abcdefghijklmnopqrst')).toBe(
      'token [REDACTED]',
    );
  });

  it('redacts ntn_* pattern in a flat string', () => {
    expect(scrubSecrets('notion ntn_abcdefghijklmnopqrst')).toBe(
      'notion [REDACTED]',
    );
  });

  it('redacts secret_* pattern in a flat string', () => {
    expect(scrubSecrets('value secret_abcdefghijklmnopqrst')).toBe(
      'value [REDACTED]',
    );
  });

  it('redacts secrets at any depth in a nested object', () => {
    const input = {
      level1: {
        key: 'sk-ant-api03-supersecretkey01234',
        level2: {
          arr: ['ghp_sometoken1234567890', 'safe-value'],
          nested: { token: 'ntn_notiontoken1234567890' },
        },
      },
    };
    const result = scrubSecrets(input);
    expect((result.level1 as { key: string }).key).toBe('[REDACTED]');
    expect((result.level1.level2 as { arr: string[] }).arr[0]).toBe(
      '[REDACTED]',
    );
    expect((result.level1.level2 as { arr: string[] }).arr[1]).toBe(
      'safe-value',
    );
    expect((result.level1.level2.nested as { token: string }).token).toBe(
      '[REDACTED]',
    );
  });

  it('leaves non-secret strings unchanged', () => {
    expect(scrubSecrets('hello world')).toBe('hello world');
    expect(scrubSecrets('sk-ant-short')).toBe('sk-ant-short'); // too short
  });

  it('passes through numbers, booleans, and null unchanged', () => {
    expect(scrubSecrets(42)).toBe(42);
    expect(scrubSecrets(true)).toBe(true);
    expect(scrubSecrets(null)).toBe(null);
  });

  it('does not mutate the input object', () => {
    const input = { secret: 'sk-ant-api03-mutationcheck1234' };
    scrubSecrets(input);
    expect(input.secret).toBe('sk-ant-api03-mutationcheck1234');
  });

  it('redacts multiple secrets in a single string', () => {
    const s = 'a=sk-ant-api03-first1234567890 b=ghp_second1234567890';
    expect(scrubSecrets(s)).toBe('a=[REDACTED] b=[REDACTED]');
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