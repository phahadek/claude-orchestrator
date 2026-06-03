## Summary

Fixes three compounding bugs in `SessionAuditor.ts` that caused false-positive `worktree_escape` violations. URL fragments inside `https://` links (e.g. the Notion task URL in a Bash command) were matched as absolute paths; Bash path-mentions (reads, arguments) were flagged even if nothing was written; and denied/blocked tool calls were audited even though they never executed.

## Notion Task

https://app.notion.com/p/Fix-worktree-escape-detector-false-positives-URL-fragments-denied-tool-calls-flagged-as-writes-37422f9152f3810294ffdbf042648e8c

## Automated Tests

`packages/backend/src/session/SessionAuditor.test.ts` — 35 tests, all passing:

- New: denied Write to outside path not flagged (tool_use_id correlation)
- New: executed Write still flagged when only other calls were denied (regression)
- New: Bash command containing Notion URL produces zero worktree_escape paths
- New: Bash path mention (not a write) produces no violation
- New: Bash redirect to inside-worktree path produces no violation
- Fixed: makeToolUseEvent helper now creates events in the real production format (text event with embedded tool_use block)

## Files Changed

- `packages/backend/src/session/SessionAuditor.ts`: extractWriteTargetsFromCommand replaces extractAbsolutePathsFromCommand (strips URLs, only extracts redirect/tee/cp/mv write targets); auditWorktreeEscape skips denied tool calls via tool_use_id; extractToolUseBlocks captures block id for denial correlation
- `packages/backend/src/session/SessionAuditor.test.ts`: adds getDenialsBySession to mock, fixes makeToolUseEvent helper, adds 5 new AC tests
