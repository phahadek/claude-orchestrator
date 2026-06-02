## Summary

Removes the `mainBranch` record + `git checkout` restore mechanism from `SessionManager`. The restore ran silently at session end and could destructively revert the main repo to a stale baseline, clobbering legitimate branch switches made by the user or other actors during the session. The orchestrator never legitimately changes the main repo's checked-out branch, so the mechanism was both redundant and harmful. The non-destructive `git status --porcelain` worktree-escape warning is preserved.

## Notion Task

https://www.notion.so/Remove-the-destructive-main-repo-branch-record-restore-in-cleanupWorktree-it-silently-git-checkout-37322f9152f3810da1b0c210cdef9377

## Automated Tests

No test changes required — no existing tests asserted the restore behavior. `branchModel.test.ts:290` ("cleanup derives branchName from worktree HEAD") continues to pass.

## Files Changed

- `packages/backend/src/session/SessionManager.ts` — removed `mainBranch` capture block from `start()`, `mainBranchResume` capture block from `_doSendOrResume()`, the `if (mainBranch) { git checkout }` restore block from `cleanupWorktree()`, and the now-unused `mainBranch?` parameter from `wireSession()` and `cleanupWorktree()` signatures
