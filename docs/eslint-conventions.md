# ESLint Conventions

## Prefer refactor over disable

When ESLint flags your code, the default response is to fix the code, not to
silence the rule. `eslint-disable` is a last resort, reserved for cases where the
rule is genuinely wrong for that specific line (a verified-safe regex, a
deliberate `any` at an API/serialization boundary, a side-effect-only import, a
trusted-admin dynamic `RegExp`, an intentionally empty dependency array, etc.).

Phase 2b of the rollout chose file-splitting over per-file disables precisely to
avoid normalizing "disable when the rule complains." Keep that bar high.

## Rules for disabling

1. Refactor first. If the rule can be cleared by restructuring the code without
   losing intent, do that instead of disabling.
2. Disable the narrowest scope. Prefer `eslint-disable-next-line <rule>` over a
   file-level or block `eslint-disable`. Never disable a rule for a whole file to
   fix one line.
3. Name the exact rule. Always `eslint-disable-next-line <plugin>/<rule>` — never
   a bare `eslint-disable` that suppresses everything.
4. Always pair a disable with a `// Reason: ...` comment explaining why the rule
   is wrong here. Format:
   `// eslint-disable-next-line <rule> -- Reason: <why this line is safe/correct>`
5. No dead directives. Do not disable a rule that is already off in
   eslint.config.js for that file's scope (e.g. security rules and
   no-explicit-any are already off for test files). CI runs
   `eslint --report-unused-disable-directives`; unused directives fail the build.

## Audit outcome (initial audit, 2026-06-17)

16 disable sites across 13 files: 14 legitimate (11 already documented with a
`// Reason:` comment, 3 backfilled), 2 removable, 0 rule-misconfigured. Two
globally noisy security rules are already disabled centrally in eslint.config.js
rather than per-line — the correct place for a rule that is wrong codebase-wide.
