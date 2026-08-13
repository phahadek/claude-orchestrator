# Path-check verification scratch

Throwaway file proving the CI markdown path-validation step fails a PR that
references a repository path which does not exist. This PR is opened purely to
capture a workflow run id and is closed immediately afterwards.

The reference below is deliberately broken — nothing at this path exists or has
ever existed:

`packages/backend/src/thisFileDoesNotExist.ts`

For contrast, this reference is real and must not be reported:

`scripts/check-markdown-paths.mjs`
