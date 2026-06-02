## Summary

Extends session-efficiency-baseline.mjs to LEFT JOIN session_audits and surface pr_wrong_base, spec_mismatch, violations_count in per-session CSV, METRICS aggregates, and top-N drivers. Adds M8 era boundary to eraOf.

## Notion Task

https://www.notion.so/Add-session_audits-dimensions-to-the-efficiency-baseline-script-37322f9152f381dcaf90d95b3d564102

## Automated Tests

No test changes — running the extended script against dashboard.db is a separate future task per spec.

## Files Changed

- `scripts/session-efficiency-baseline.mjs` — LEFT JOIN session_audits; compute pr_wrong_base/spec_mismatch/violations_count per session; add all three to METRICS, per-session CSV, and top-N drivers; add M8_START constant and M8 branch in eraOf; extend ERA_ORDER with 'M8'
