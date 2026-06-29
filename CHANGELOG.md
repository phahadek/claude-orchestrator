# Changelog

All notable changes to Claude Orchestrator are documented here.

<!-- Entries follow Keep a Changelog format: https://keepachangelog.com -->

## [Unreleased]

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
