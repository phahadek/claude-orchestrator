#!/usr/bin/env node
// Claude Code PreToolUse hook: grooming promotion gate.
//
// Part of the user-global grooming system (groom-load.mjs + skills/groom/ +
// this). Blocks promoting a grooming-tracked task to its Ready status via
// notion-update-page unless three artifacts are recorded for it in
// .skill-cache/grooming/<milestone>/grooming-state.json: a human signoff,
// a hard_block_deps array, and a size_check classification. The loader
// seeds the file, the skill fills the three fields, this gate checks
// them — so a task cannot reach Ready without all three. (Old path
// .claude/grooming/<milestone>/grooming-state.json is read as a fallback
// for pre-migration caches; see findStateEntry.)
//
// Exit 0 = allow. Exit 2 = block (stderr is fed back to the session so it can
// self-correct). Fail-open by design: any repo without grooming configured, any
// page not loaded by a groom session, or any IO/parse error → allow, so the gate
// never interferes with unrelated Notion edits.
//
// Source-controlled in claude-orchestrator (scripts/groom-gate.mjs) and deployed to
// ~/.claude/scripts/ by scripts/deploy-grooming.mjs. Registered in ~/.claude/settings.json
// as a PreToolUse hook on mcp__claude_ai_Notion__notion-update-page (alongside
// check-task-status.mjs — both run; any deny blocks).

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, sep } from 'path';

const DEFAULT_STATUS_PROP = 'Status';
const DEFAULT_READY = '🗂️ Ready';

let raw = '';
try {
  for await (const chunk of process.stdin) raw += chunk;
} catch {
  process.exit(0);
}

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const toolName = typeof input?.tool_name === 'string' ? input.tool_name : '';
if (!toolName.endsWith('notion-update-page')) process.exit(0);

const args = input?.tool_input;
const cwd = typeof input?.cwd === 'string' ? input.cwd : '';

// Only property updates can change Status.
if (args?.command !== 'update_properties') process.exit(0);

const props = args?.properties ?? {};
const { statusProp, readyVal } = loadStatusConfig(cwd);

// Not a promotion to the Ready status → out of scope, allow.
if (props[statusProp] !== readyVal) process.exit(0);

const pageId = normalizeId(args?.page_id);
if (!pageId) process.exit(0);

const entry = findStateEntry(cwd, pageId);
// Not a grooming-tracked task (no manifest, no cache, or page not loaded by a
// groom session) → don't interfere.
if (!entry) process.exit(0);

const s = entry.signoff;
const signedOff = s && s.by && s.at;
// hard_block_deps must be an array (possibly empty) — null means the skill never
// classified deps and likely left sequencing in the body. See the groom skill's
// Step 4 + "Locking sequencing in the task body" anti-pattern.
const depsClassified = Array.isArray(entry.hard_block_deps);
// size_check must be an object with a recognized decision — null means the skill
// never ran the size check, which is load-bearing per /groom presentation.md.
// Valid shapes: {decision: "no_split"|"split_now"|"unsplittable"|"n/a", ...}
const sc = entry.size_check;
const sizeClassified =
  sc &&
  typeof sc === 'object' &&
  typeof sc.decision === 'string' &&
  ['no_split', 'split_now', 'unsplittable', 'n/a'].includes(sc.decision);

// repo_assignment check: multi-repo project tasks require an assigned repo.
// Fail-open: absent repo_assignment field = not a multi-repo task → allow.
const ra = entry.repo_assignment;
const repoAssigned =
  !ra ||
  !ra.multi_repo ||
  (typeof ra.repo === 'string' && ra.repo.trim() !== '');

if (signedOff && depsClassified && sizeClassified && repoAssigned)
  process.exit(0); // fully gated → allow

const reasons = [];
if (!signedOff) {
  reasons.push(
    `no grooming sign-off is recorded (set signoff:{"by","at"} in grooming-state.json after the human approves the batch)`,
  );
}
if (!depsClassified) {
  reasons.push(
    `hard_block_deps is not an array — the skill must explicitly classify dependencies as hard-block (→ Depends On property) vs soft-order (→ batch chat only) and write the hard-block array (empty if none) to grooming-state.json before promotion. Sequencing locked in the task body alone is invisible to downstream sessions; see the /groom skill's Step 4`,
  );
}
if (!sizeClassified) {
  reasons.push(
    `size_check is missing or malformed — every Code/Tooling task in a batch must have an explicit size classification recorded in grooming-state.json before promotion. Expected shape: {"loc": <number>, "decision": "no_split"} for ≤500 LoC tasks, "split_now" with "split_into" task IDs after splitting (edit the original down + create N-1 siblings; do NOT mark the original Deferred), "unsplittable" with a one-line "reason" for atomic tasks, or {"decision":"n/a"} for Design/Planning. The size check is load-bearing — see /groom presentation.md § Size check`,
  );
}
if (!repoAssigned) {
  reasons.push(
    `this task belongs to a multi-repo project but has no repo assigned — set repo_assignment: {"multi_repo": true, "repo": "<repo-name>"} in grooming-state.json before promotion. Assign the target repo during the grooming session and confirm it in the state file`,
  );
}

console.error(
  `Promotion blocked: task ${pageId} is being set to '${readyVal}', but ` +
    reasons.join('; AND ') +
    `. After fixing, re-issue this status update in the same notion-update-page call that writes the canonical Depends On value. ` +
    `If you are not in a /groom session, the human must approve the promotion first.`,
);
process.exit(2);

// ── helpers (all fail-open: return defaults / null on any error) ──────
function normalizeId(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/-/g, '').toLowerCase().trim();
}

function loadStatusConfig(cwd) {
  for (const mp of manifestCandidates(cwd)) {
    try {
      const m = JSON.parse(readFileSync(mp, 'utf8'));
      return {
        statusProp: m.status_property ?? DEFAULT_STATUS_PROP,
        readyVal: m.status_vocab?.ready ?? DEFAULT_READY,
      };
    } catch {
      /* try next candidate */
    }
  }
  return { statusProp: DEFAULT_STATUS_PROP, readyVal: DEFAULT_READY };
}

// Candidate manifest paths, central tree first, legacy <repo>/.claude/grooming.json last.
// The hook gets only `cwd`; normalize a worktree cwd (<repo>/.claude/worktrees/<id>) back to
// the repo root, then probe the central tree the way the loaders do — $ORCHESTRATOR_CONFIG_DIR,
// then the host-aware default (a `config/` dir beside the projects root: dev <repo>/../config,
// prod <repo>/../../config) — keyed by the repo basename. Fail-open: defaults cover any miss.
function manifestCandidates(cwd) {
  const wt = cwd.indexOf(`${sep}.claude${sep}worktrees${sep}`);
  const repo = wt !== -1 ? cwd.slice(0, wt) : cwd;
  const base = repo.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const out = [];
  const env = process.env.ORCHESTRATOR_CONFIG_DIR;
  if (env) out.push(join(env, 'projects', base, 'grooming.json'));
  out.push(join(repo, '..', 'config', 'projects', base, 'grooming.json')); // dev shape
  out.push(join(repo, '..', '..', 'config', 'projects', base, 'grooming.json')); // prod shape
  out.push(join(cwd, '.claude', 'grooming.json')); // legacy fallback
  return out;
}

function findStateEntry(cwd, pageId) {
  // Cache moved from <repo>/.claude/grooming/ to <repo>/.skill-cache/grooming/ on
  // 2026-06-21 to avoid Claude Code's sensitive-file classifier on .claude/ writes.
  // Falls back to the old path so caches written by older skill versions still resolve.
  for (const root of ['.skill-cache', '.claude']) {
    try {
      const groomingDir = join(cwd, root, 'grooming');
      if (!existsSync(groomingDir)) continue;
      for (const dirent of readdirSync(groomingDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const statePath = join(groomingDir, dirent.name, 'grooming-state.json');
        if (!existsSync(statePath)) continue;
        let state;
        try {
          state = JSON.parse(readFileSync(statePath, 'utf8'));
        } catch {
          continue;
        }
        for (const [key, val] of Object.entries(state)) {
          if (normalizeId(key) === pageId) return val ?? {};
        }
      }
    } catch {
      /* try next root */
    }
  }
  return null;
}
