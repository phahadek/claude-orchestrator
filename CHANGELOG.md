# Changelog

All notable changes to Claude Orchestrator are documented here.

<!-- Entries follow Keep a Changelog format: https://keepachangelog.com -->

## [Unreleased]

### Fixed

- Boot now refuses to silently create a fresh, empty database when the resolved `db.path` has no file but a populated one still exists at a pre-2.0.0 legacy location (working-directory-relative, or relative to the backend package directory) — the exact failure mode the 2.0.0 storage-path change (below) left open. Boot also now logs the resolved absolute database path and row counts for the core tables, so a mismatch is self-diagnosing instead of requiring a manual hunt through path-resolution code.

## [2.2.0] - 2026-08-23

**M15.** Reliability hardening for the session/test infrastructure layer.

### Fixed

- Orphaned and stuck session processes are now force-killed with a SIGKILL escalation and exit verification after SIGTERM, instead of being able to survive every sweep indefinitely.
- Test-runner subprocesses are killed by process group with re-parented-worker and cgroup coverage, closing leaks that could swap tens of GB and stall the event loop.
- `audit_log.task_id_norm` migration no longer crash-loops the backend on a populated database.
- Base-health no longer classifies a single timed-out test run as a total failure that halts all code dispatch; `test_timeout_sec` raised from 300 to 900 to match the suite's real runtime.
- A lost git ref-lock race no longer writes a false "session may be starting from a stale base" error onto the session.
- Numerous stuck/stalled-session monitor, deploy-identity-capture, and gate-verify dispatch fixes.

## [2.1.0] - 2026-08-13

**M14.** Review-pipeline and grooming/design flow quality-of-life milestone.

### Added

- Depth-review findings are now auto-routed to the implementing session across all severity dimensions, and the verdict is persisted so the operator's Fix control reflects it (previously visible only in a log line and a 10-second toast).
- `not-yet-triggerable` added to the gate-verify disposition vocabulary, so a verifier can re-park an item instead of only ever shelving it via `needs-setup`.
- Markdown path-validation step added to the CI build workflow.

### Fixed

- A dispatched groom session is now told its deliverable is a decision about the task, not the task's own deliverable.
- The ops-terminal group guard no longer treats a follow-on `task.create` as automatically closing, which had blocked a session from committing without falsely claiming resolution.

## [2.0.0] - 2026-08-02

**M13 — Manual Verification Gate rework.** Major storage-path and gate-architecture milestone.

### Changed

- **BREAKING:** A relative `db.path` now resolves against the per-OS application data directory (see `getDataDir()` in `packages/backend/src/config/dataDir.ts`) instead of the backend process's working directory. Absolute `db.path` values are unaffected.

  An existing install whose `db.path` was left at the shipped relative default (`./dashboard.db`) will, on first boot after upgrading, find no database at the new resolved location and build a fresh, empty one there — while the real database remains untouched at the old, working-directory-relative path. Nothing is lost, but the dashboard will appear empty until the database is relocated.

  **Manual copy recipe** — before starting the upgraded backend, locate your existing `dashboard.db` (by default, in the directory you previously launched the backend from) and copy it to the new resolved location:
  - Linux: `${XDG_DATA_HOME:-~/.local/share}/claude-orchestrator/dashboard.db`
  - macOS: `~/Library/Application Support/ClaudeOrchestrator/dashboard.db`
  - Windows: `%APPDATA%\ClaudeOrchestrator\dashboard.db`

  Alternatively, set `db.path` to an absolute path pointing directly at the existing file — an absolute path is never affected by this change. Note that `config.json` takes precedence over `.env`, so a `db.path` fix applied only to `.env` will silently have no effect if `config.json` already sets it.
- The gate-verify adjudication layer was retired: `gate.verify` is now staged as a normal intent and disposed by the operator on the standard decision surface, instead of through a separate adjudication path.

### Added

- Config precedence hardened: config.json now falls back per-field to `.env` when a field is omitted or empty, and a database file that already existed before open but carries no application schema now fails loudly instead of silently building a fresh schema on top of it.
- Schema-enforced terse expected/found evidence contract for `gate.verify`, replacing free-prose evidence.
- Backend and frontend test steps added to the CI build workflow so failing tests block a PR.

## [1.6.0] - 2026-06-29

**M9 — Architectural Debt Paydown.** Major stabilization milestone (closes M9).

### Added

- LAN device enrollment: first-device bootstrap on localhost, any-enrolled-device approval flow, and device-auth tokens attached to all frontend API calls.
- 🚦 Gate task type for milestone manual-verification gates.
- Non-blocking boot reconciliation with a live "booting — step X of Y" view; continuous worktree pruning moved off the boot hot path.
- Unified Scheduler abstraction for ad-hoc timed sweepers, with a System Health panel.
- Jira task-source parity and multi-repo / assignee-scoped task sources.
- Central, repo-decoupled orchestrator config tree (procedures + per-project context) plus deployed grooming/design skills.
- `analyze:` static-analysis gate (lint / knip / gitleaks / npm audit) in the pre-review pipeline.

### Changed

- Unified PauseReason taxonomy (`{source, severity, retry_strategy}`) across backend persistence and frontend pipeline badges.
- Pre-review pipeline consolidated into a single state-machine owner.

### Fixed

- Dependency resolver now blocks dispatch on ⏭️ Deferred dependencies (only ✅ Done satisfies a dependency).
- Numerous session-lifecycle, review-chain, auto-merge, and worktree-reconciliation hardening fixes.

## [1.1.0] - 2026-05-31

### Added

- Windows installer via Inno Setup
- macOS installer (.app bundle + .dmg)
- Linux installer (.deb with GPG signing + .AppImage)
- GitHub Actions release pipeline (tag-triggered matrix builds)
