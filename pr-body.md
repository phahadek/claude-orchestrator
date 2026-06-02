## Summary

Prepends a dimmed `#NNN` badge inside the title link of each compact PR history row, making it easy to identify PRs at a glance without hovering.

## Notion Task

https://www.notion.so/PR-panel-compact-row-hides-the-PR-number-only-the-title-is-clickable-no-NNN-text-visible-37322f9152f3813d99dacfa13aeb6b8e

## Automated Tests

- `PRHistoryRow.test.tsx`: updated `renders PR title linking to prUrl` to match new accessible name `#42 feat: add dashboard`
- `PRHistoryRow.test.tsx`: added `renders PR number #NNN in the title` — renders with `prNumber=153`, asserts `#153` text appears

## Files Changed

- `packages/frontend/src/components/PRHistoryRow.tsx` — wraps `#{pr.prNumber}` in a `<span className={styles.prNumber}>` inside the title anchor
- `packages/frontend/src/components/PRHistoryRow.module.css` — adds `.prNumber` rule with dimmed color (`#6c7086`) and small font
- `packages/frontend/src/components/__tests__/PRHistoryRow.test.tsx` — fixes broken accessible-name match and adds `#153` assertion
