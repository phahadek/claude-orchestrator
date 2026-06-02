## Summary

Unifies the two divergent session-resume code paths in `SessionManager`. `sendOrResume`'s resume branch was allocating a new `crypto.randomUUID()` session ID and wiring only the `message` event, silently breaking verdict routing (`needs_changes` never reached the original coder card) and review spawning (`pr_opened` not forwarded to `ReviewOrchestrator`). Fixed by extracting a shared `respawnSession` helper that reuses the original session ID and delegates full event wiring to `wireSession`, plus a concurrency guard to prevent double-spawning.

## Notion Task

https://www.notion.so/Sessions-resumed-via-sendOrResume-lose-event-wiring-get-a-new-id-breaks-verdict-routing-needs_c-37322f9152f381b7b0c0ecf22b5185da

## Automated Tests

**`packages/backend/src/session/__tests__/SessionManager.test.ts`** (new, 13 tests):

- `sendOrResume` on dead session reuses original session ID (no new UUID)
- DB row is updated (not inserted) to `running`
- `worktree_path` updated in DB for respawned session
- `pr_opened` forwarded from resumed session to `SessionManager`
- `push_detected` forwarded from resumed session to `SessionManager`
- User message recorded under original session ID
- Concurrency guard: two concurrent calls result in one spawn
- Live session fast path: delivers via `send()` directly
- `respawnSession` shared helper wires all three events
- `resumeOrphanSessions` boot recovery regression: reuses ID + wires events

**`packages/backend/src/github/__tests__/ReviewOrchestrator.test.ts`** (new, 5 tests):

- `needs_changes` verdict calls `sendOrResume` with original coder session ID
- Formatted feedback passed to `sendOrResume`
- `approved` verdict does NOT call `sendOrResume`
- Synthetic PR #158 reproducer: dead coder session gets feedback under original ID
- `pr_opened` subscription wired in constructor

## Files Changed

- `packages/backend/src/db/queries.ts` — added `updateSessionWorktreePath` query to update the `worktree_path` column on an existing session row
- `packages/backend/src/session/SessionManager.ts` — added `ISessionRunner` import; added `resumesInFlight` concurrency guard; added `respawnSession` private helper (creates session with original ID, registers, updates DB, emits status); refactored `resumeSession` to use helper; rewrote `sendOrResume` resume branch as `_doSendOrResume` (original ID, full `wireSession` wiring, concurrency guard)
- `packages/backend/src/session/__tests__/SessionManager.test.ts` — new test file covering all acceptance criteria
- `packages/backend/src/github/__tests__/ReviewOrchestrator.test.ts` — new test file covering verdict routing and PR #158 reproducer
