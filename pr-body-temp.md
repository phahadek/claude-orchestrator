## Summary

Introduces `EventKind` + `eventKind(row)` in `session/eventKind.ts` as the canonical derivation for a session event's logical kind, handling both live full-event payload and JSONL ev.content storage shapes. Converts the four dead/buggy `event_type` direct-comparison sites to route through `eventKind()`: `isTransientApiError` (revives 500/529 retry), mid-turn detection in `resumeSession`, and the tool_use branch in `extractToolUseBlocks`. Non-breaking: EventType column union unchanged.

## Notion Task

https://app.notion.com/p/Introduce-eventKind-derivation-fix-the-dead-event-kind-filters-Step-1-correctness-critical-37422f9152f3816da6f5d0c16bd5fe98

## Automated Tests

- `packages/backend/src/__tests__/eventKind.test.ts` (new — 23 tests covering both writer shapes, regression for transient-error retry, mid-turn detection, reaper result detection)

## Files Changed

- `packages/backend/src/session/eventKind.ts` — new: EventKind type + eventKind(row) function
- `packages/backend/src/session/AgentSession.ts` — fix isTransientApiError: event_type check → eventKind()
- `packages/backend/src/session/SessionManager.ts` — fix mid-turn detection: direct event_type → eventKind()
- `packages/backend/src/session/SessionAuditor.ts` — fix dead tool_use branch in extractToolUseBlocks: event_type → eventKind()
- `packages/backend/src/__tests__/eventKind.test.ts` — new: unit + regression tests
