# Path-check verification scratch

Throwaway docs-only file proving the CI markdown path-validation step passes a
PR whose repository-relative references all resolve. This PR is opened purely to
capture a workflow run id and is closed immediately afterwards.

Every reference below is real and tracked:

- `scripts/check-markdown-paths.mjs` — the checker itself
- `scripts/__tests__/check-markdown-paths.test.mjs` — its unit tests
- `.github/workflows/build.yml` — the workflow carrying the step
- `packages/backend/src/routes/stagedIntents.ts` — an ordinary source reference
- `docs/task-writing.md` — an ordinary docs reference
