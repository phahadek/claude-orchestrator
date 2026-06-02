## Summary

When a backend restart orphans a coder session mid-flight, `resumeSession` now injects the PR's stored review verdict into the resume nudge instead of sending the generic "continue implementing" message. The coder no longer needs to query GitHub (where verdicts are never posted) — it gets the verdict directly from the DB-backed resume message.

## Notion Task

https://www.notion.so/Resumed-coder-session-can-t-see-orchestrator-s-review-verdict-queries-GitHub-for-PR-reviews-finds-37322f9152f381fe9140c6d67c1f34c6

## Automated Tests

- `packages/backend/src/__tests__/reviewUtils.test.ts` (new) — unit tests for `formatApprovedVerdictMessage`: verifies ✅ Approved heading, summary inclusion, "no action needed" guidance, and auto-merge mention
- `packages/backend/src/__tests__/SessionManager.test.ts` (updated) — structural tests for `buildResumeMessage`: verifies `getPRBySessionId` lookup, `RESUME_NUDGE_MESSAGE` fallback for missing PR / null review_result / malformed JSON, `formatReviewFeedback` for needs_changes/incomplete, `formatApprovedVerdictMessage` for approved, and that `resumeSession` uses `buildResumeMessage(row)` instead of the plain nudge directly

## Files Changed

- `packages/backend/src/github/reviewUtils.ts` — added `formatApprovedVerdictMessage(result)` export, a sibling of `formatReviewFeedback`
- `packages/backend/src/session/SessionManager.ts` — added imports for `formatReviewFeedback`, `formatApprovedVerdictMessage`, `PRReviewResult`; added `private buildResumeMessage(row)` helper; changed `resumeSession` to call `buildResumeMessage(row)` instead of using `RESUME_NUDGE_MESSAGE` directly
- `packages/backend/src/__tests__/reviewUtils.test.ts` (new) — unit tests for `formatApprovedVerdictMessage`
- `packages/backend/src/__tests__/SessionManager.test.ts` — updated existing nudge test + added `buildResumeMessage` structural test suite
