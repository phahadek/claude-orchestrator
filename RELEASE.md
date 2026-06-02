# Release Process

## Steps

### 1. Bump the version on `dev`

Run the release-prep script from the repo root, passing the target version:

```bash
node scripts/release.mjs <version>
# Example: node scripts/release.mjs 1.5.0
```

The script:

- Bumps `version` in `package.json` (root), `packages/backend/package.json`, and `packages/frontend/package.json` to the target version.
- Verifies `packages/backend/package.json` was written correctly (the field the auto-updater reads).
- Commits with message `chore(release): bump version to X.Y.Z`.

> **Why this matters:** `UpdateChecker` reads `packages/backend/package.json` as the
> _current_ version and compares it against the latest GitHub release tag. If the
> field lags behind the tag (as happened before v1.4.0), every installed instance
> will show a perpetual "update available" banner even when fully up to date.

### 2. Open a PR from `dev` → `main` and merge

Push the version-bump commit (already on `dev`) and merge it into `main` via the normal PR flow.

### 3. Tag `main` and push the tag

```bash
git tag v<version> main
git push origin v<version>
```

### 4. Create a GitHub Release

Create a GitHub Release from the tag. The CI workflow triggers on new tags and builds the platform installers.

## Version format

`MAJOR.MINOR.PATCH` following [semver](https://semver.org/). Tag prefix is `v` (e.g. `v1.5.0`); `package.json` stores the bare number (e.g. `1.5.0`).
