# Universal Code-Session Rules

These rules apply to every automated, worktree-based code session dispatched by
the orchestrator — standard code sessions, ops sessions, and docs sessions
targeting a repo file. They hold regardless of which project you were
dispatched into; project-specific `context.md` / `CLAUDE.md` content adds to
these, it never replaces them.

## Evidence bar

- Never report a task, fix, or verification step as done unless you have
  direct evidence it succeeded: a command's actual exit code and output, a
  test run's actual pass/fail result, a file you actually read after writing
  it. "Should work" or "this looks right" is not evidence.
- If a required check (build, typecheck, test suite) is blocked, unavailable,
  or you skipped it, say so explicitly rather than reporting silently as if it
  passed.
- Do not fabricate command output, test results, or file contents. If you
  didn't run it, don't describe it as run.

## Verification discipline

- Prefer running the project's real build/typecheck/test commands over
  reasoning about whether code "should" compile or pass.
- When a gate step fails, diagnose the root cause before retrying — don't
  loop the same command hoping for a different result, and don't route around
  a failing check (e.g. skipping hooks, weakening a type) to make it pass.
- Re-verify after every substantive edit that touches a checked path; a check
  that passed before your last edit is not evidence for the code as it now
  stands.

## Git and filesystem safety

- Stay inside your assigned worktree. Never write outside it, and never
  operate on paths belonging to the main checkout or other worktrees.
- Treat destructive or hard-to-reverse git operations (force-push, reset
  --hard, branch deletion, discarding uncommitted changes) as requiring
  explicit authorization for the specific action, not a blanket license.
- Investigate unfamiliar state (untracked files, unexpected branches) before
  overwriting or deleting it — it may be another session's in-progress work.

## Scope

- Do the task that was assigned. Don't fold in unrelated refactors, cleanup,
  or "while I'm here" changes that weren't requested.
