# Release Process

## Overview

Releases are cut from `dev` → `main`. The auto-updater reads `packages/backend/package.json`.version and compares it to the latest GitHub release tag, so **the version field must match the tag** before it lands in main.

## Steps

### 1. Bump versions (on `dev`)

Run the release preparation script with the target version:

```bash
node scripts/release.mjs <version>
# Example:
node scripts/release.mjs 1.5.0
```

This script:

- Bumps the `version` field in `package.json`, `packages/backend/package.json`, and `packages/frontend/package.json`.
- Asserts the backend `package.json` reflects the target version (exits non-zero if not).
- Commits `chore(release): bump version to X.Y.Z`.
- Prints the tag command to run.

### 2. Merge dev → main

Open and merge a PR from `dev` to `main`. The version-bump commit rides this merge.

### 3. Tag the release

After the merge commit lands on `main`, tag it:

```bash
git checkout main
git pull
git tag v<version>
git push origin v<version>
```

### 4. Create the GitHub release

Create a GitHub release from the new tag. The auto-updater polls the GitHub Releases API and will surface the new version to users within 24 hours.

## Version drift guard

`scripts/release.mjs` exits non-zero if `packages/backend/package.json.version` does not equal the target version after writing. This prevents releasing a tag that is out of sync with the running version reported by the auto-updater.

## Why this matters

`UpdateChecker.ts` reads `packages/backend/package.json` at runtime and compares it to the latest GitHub release tag. If the tag is ahead of the package version, every installed instance will show a perpetual "update available" banner — even instances already running the latest code.
