# Architecture-page edit protocol

The single most reversible-but-easy-to-skip step in the skill. The architecture
context — the 7 Notion context pages and the Future Scope page for a project that
hasn't adopted the arch_unit store, or the store's units for one that has — is
load-bearing for every downstream session. Silent edits there are the most
damaging mistake a Design Execution session can make. This protocol exists to
make silent edits impossible.

## Which branch applies

Check the current task's `arch_source` (from `design-worklist.json`, Step 1 of
`SKILL.md`) before doing anything else here:

- **`arch_source: 'notion'`** — the project has not adopted the arch_unit store.
  Follow **Two sub-procedures** below unchanged: fetch the Notion page, diff,
  sign-off, `notion-update-page`.
- **`arch_source: 'store'`** — the project has adopted the arch_unit store. The
  Notion context pages are no longer canonical (they are slated for retirement
  to read-only pointers) — **never** write to them for a locked decision. Skip
  straight to **Procedure C — stage an `arch.*` intent**, below. Never write
  both: a migrated project's architecture lives in exactly one place.

This branch is **per-project, not per-page or per-task** — `arch_source` is the
same for every task in a session against the same project; there is no mixed
mode.

---

## Voice and altitude — durable design, not session narrative

Architecture pages describe what the system **is**, in durable terms. They are
not session logs, decision narratives, or summaries of what a specific Design
task locked. A future reader picks up the page with no memory of the
milestone, no context for the Design task that triggered this edit — and they
must be able to use the page without that history.

The same factual content can be written either way. Compare:

> ❌ _Session-narrative voice:_ "After the M9 timezone investigation
> (38522f91-…-81ca), we determined that Liquipedia `scheduled_at` is unreliable
> for date-only matches, so the link deriver was re-anchored on the bo3.gg
> precise window."

> ✅ _Durable-design voice:_ "The market↔match link deriver anchors on the
> bo3.gg precise window. Liquipedia `scheduled_at` is the fallback, used only
> when bo3.gg data is absent — Liquipedia entries are sometimes date-only and
> are not authoritative for window-precise matching."

Both convey the same contract; only the second describes the _system_. The
first describes the _decision_.

Before drafting any edit, run the **durability check** on your proposed text:

- **Tense.** Present-tense declarative. State what the system does, not what
  someone decided it should do.
- **Origin story.** Strip task IDs, milestone tags, dates, _"we"_, _"this
  design"_, _"as of M9"_, _"after the recent investigation"_. If a fact only
  makes sense given originating context, it belongs in the Design task's
  Implementation notes — not on the arch page.
- **Rationale.** Keep what a future implementer needs to _use the contract
  correctly_ (the _why_ that prevents future misuse — _"Liquipedia entries are
  sometimes date-only"_). Drop what they only need to _understand the history_
  (the _how-we-got-here_ — _"we considered X but ruled it out because Y"_).
  Defensive rationale belongs in the Design task body's Implementation notes.
- **Naive-reader test.** Read your draft as someone with zero session context.
  Does it read as a description of the system, or as a report of what someone
  decided? If the latter, rewrite.

If the surrounding section is already polluted with session narrative —
sprinkled task IDs, _"as of M<n>"_ references, decision history — **do not
echo the drift.** Match the _intended_ altitude of the page, not whatever has
accumulated. Cleaning up legacy contamination is a separate Backlog task; do
not fold it into an in-flight edit, and do not let it license writing more.

The durability check runs **before** the diff-then-apply protocol below. A
diff that's voice-wrong should be rewritten, not approved.

## Two sub-procedures (`arch_source: 'notion'` only)

### A. Edit existing content

1. **Fetch the target page** via the loader's cached body in
   `.skill-cache/design/<M>/context/<page-id>.md`, **or** by calling
   `node ~/.claude/scripts/notion-page.mjs <page-id> --format md --env <env>`
   if the page isn't in the manifest's `context_pages`. Read the full body —
   not an MCP search excerpt; the search result is capped and truncated.

2. **Locate the section to amend.** Identify the heading hierarchy (e.g.
   `## Analysis Layer Outputs > ### L2 meta-analyzers`) and the specific lines
   or paragraph being replaced. If the target is mid-paragraph, quote enough
   surrounding text that the diff is unambiguous.

3. **Compose the exact replacement text.** Match the page's existing voice
   and formatting — heading levels, bullet style, code-fence languages, the
   way the page introduces tables. The diff should read as _part of the page_,
   not as bolted-on commentary.

4. **Present in chat:**

   > I'm going to update **`<page title>`** § **`<section heading>`** — replace
   > the following N lines:
   >
   > ```
   > <quoted old text, verbatim>
   > ```
   >
   > with:
   >
   > ```
   > <new text, verbatim>
   > ```
   >
   > Okay to apply?

5. **Wait for explicit sign-off.** _"yes"_, _"apply"_, _"go ahead"_, _"ok"_ —
   the exact word doesn't matter, but the human has to say it. Silence is not
   approval.

6. **Apply via** `mcp__claude_ai_Notion__notion-update-page`. Confirm in chat:
   _"Applied to `<page title>` § `<section>`."_

7. **Stamp** `design-state.json` → `pages_affected[i].applied_at` (ISO-8601
   UTC) and `applied_diff` (a short fingerprint: heading + first ~80 chars of
   new text). The session summary in Step 4 reads from this.

### B. Add a new section

Same as A, but step 2 is _"locate the anchor section the new one follows"_
and step 4 is:

> I'm going to add a new section to **`<page title>`** after § **`<anchor
heading>`**:
>
> ```
> <full new section, verbatim — heading + body>
> ```
>
> Okay to apply?

### C. Stage an `arch.*` intent (`arch_source: 'store'` only)

The store is canonical for this project, so the write target is an arch_unit,
never a Notion page — and unlike A/B, **applying an intent isn't this
session's decision.** The session stages; the operator applies (or
group-commits) through the decision surface. "Staged" is the terminal state
for this session, not "applied."

1. **Classify the write** against `arch_units[]` (Step 1's dual-read
   selection) and the locked decision:
   - A wholly new architecture statement (no existing unit covers it) → **create**.
   - An existing unit's title/body/metadata changes but the unit's identity
     doesn't → **update**.
   - An existing unit is retired and replaced by a new one (a rename-with-
     redefinition, a split into several units) → **supersede**. A split that
     produces more than one new unit stages every create/supersede in the
     split under the **same `groupId`**, so the operator commits them
     atomically — never one alone; a partial split leaves the store
     inconsistent.

2. **For update/supersede, get the current `baseVersion`.** Prefer the version
   already inlined on the `arch_units[]` entry from Step 1; if it's stale
   (this session has been running a while) or absent, re-fetch with
   `mcp__orchestrator__architecture_getUnit` (`{id}`). Staging against a
   version another apply has since advanced past is rejected at apply time —
   a `StaleArchUnitVersionError` — and requires re-staging against the
   current version; this is expected and not a bug to work around by
   guessing a version.

3. **Compose the exact new/updated body.** Same durability check as
   procedures A/B — present-tense declarative, no origin story, keep only the
   rationale a future reader needs to use the contract correctly.

4. **Present in chat**, mirroring the diff-then-apply shape:

   > I'm going to **stage** an `arch.<createUnit|updateUnit|supersedeUnit>`
   > intent for **`<unit title>`**:
   >
   > ```
   > <full new/updated body, verbatim>
   > ```
   >
   > This stages the intent for operator apply — it does not go live in this
   > session. Okay to stage?

5. **Wait for explicit sign-off** — same bar as procedures A/B. Silence is not
   approval.

6. **On sign-off, stage via the matching MCP tool** — never apply directly,
   and never fall back to a Notion write for a store-sourced task:
   - New unit → `mcp__orchestrator__arch_createUnit` with
     `{"payload": {"title": "<title>", "metadata": {"kind": "<subsystem|invariant|decision|contract|reference>", "topic": "<topic>", "regions": ["<region>"]}, "body": "<new body>"}}`.
   - Update → `mcp__orchestrator__arch_updateUnit` with
     `{"payload": {"unitId": "<unit-id>", "baseVersion": <current-version>, "title": "<title, if changed>", "body": "<updated body>"}}`.
   - Retire + replace → `mcp__orchestrator__arch_supersedeUnit` with
     `{"payload": {"unitId": "<unit-id>", "baseVersion": <current-version>, "replacement": {"title": "<title>", "metadata": {...}, "body": "<new body>"}}}`.
   - A split's every create/supersede call shares one `groupId` (any stable
     string unique to this split, e.g. the Design task's id).
   - Give every call a `decisionProposal`: the locked decision's rationale, in
     durable-design voice — this is the operator's sign-off surface for the
     apply, distinct from (and in addition to) this chat's sign-off.

7. **Confirm in chat:** _"Staged `arch.<kind>` for `<unit title>` (intent
   `<intentId>`) — awaiting operator apply."_

8. **Stamp** `design-state.json` → `pages_affected[i].applied_at` (ISO-8601
   UTC, the staging time) and `applied_diff` (`"staged arch.<kind> <intentId>
   — awaiting operator apply"`, plus the same short fingerprint as A/B). The
   Implementation notes' "Architecture units updated" section (renamed from
   "Notion pages updated" for a store-sourced task) reports staged, not
   applied — do not report a staged intent as if it were already live.

The "after" anchor is the load-bearing detail. _"Add a section about X"_ is
ambiguous about placement; _"after § 'L2 meta-analyzers'"_ is not.

---

## Quoting context (`arch_source: 'notion'`; the same bar applies to a staged `arch.*` body)

The diff is the gate, and the gate only works if the human can read the diff
without re-opening Notion. So:

- **For edits inside short sections (<20 lines):** quote the full section.
- **For edits inside long sections:** quote ≥3 lines before and after the
  changed lines as orientation, then show the changed lines.
- **For appends to the end of a section:** quote the last 3–5 lines of the
  section so the human sees where the new text lands.
- **For the 7 context pages and Future Scope:** quote more, not less. These
  pages are read by every downstream session; a wrong edit cascades. Err
  toward quoting too much context.

---

## Decisions about which page to update (`arch_source: 'notion'` only)

For a store-sourced task, the equivalent classification (create / update /
supersede, and which existing unit an ambiguous reference means) is Procedure
C step 1 — there is no page/section ambiguity because `arch_units[]` already
names the candidate units.

The Design task's `## Notion pages affected` section names the targets, but
sometimes inexactly:

- **Page named, section unclear.** Read the page, propose a section, confirm:
  _"This belongs under § X — agree?"_ Don't pick silently.
- **Section named but doesn't exist.** Either propose creating it (procedure
  B), or propose the closest existing section as the home (procedure A). Surface
  the choice; don't pick silently.
- **`(new)` annotation in the task body.** The task expects a new page. Don't
  create new top-level Notion pages from a Design session — surface that the
  human probably wants to file this as a sibling Notion-page-creation task
  rather than fold it into this Design task.
- **Page not in `manifest.context_pages`.** Could still be a real arch page
  (Future Scope, an Analysis-layer page, the MCP-tools index). Fetch it
  directly with `notion-page.mjs <id>` if the task body cites an ID; otherwise
  ask the human for the page URL.

---

## Applying via `notion-update-page` — `update_content` mechanics (`arch_source: 'notion'` only)

The diff is approved; applying it exactly is its own small minefield. Two rules
from real edits:

- **Replace multiple consecutive blocks with one `content_updates` entry _per
  block_ — never a newline-joined multi-paragraph `old_str`.** Notion serializes
  each paragraph (and each list item, heading, table row) as a **separate block**;
  an `old_str` that joins several of them with `\n` / `\n\n` matches nothing and the
  call fails. Split the replacement into one search/replace per block. (A
  whole-section rewrite is likewise cleaner as `insert_content` of the new section
  plus per-block deletes than as one giant `old_str`.)
- **Anchor on a heading, not on prose.** Matching or prepending relative to a
  stable heading (`## Write Authority…`) is far more reliable than anchoring on a
  prose line with em-dashes, italics, inline code, or bare domains — Notion
  re-serializes those (bare domains auto-linkify, quotes may curl, `~` escapes), so
  an exact-match `old_str` copied from the markdown export silently fails. When a
  match fails, either move the anchor to the nearest heading, or re-fetch the page
  via MCP and copy the exact _serialized_ text. (The design-skill instance of the
  `update_content` serialization caveat in `procedures.md` § Notion access.)

---

## What never to do

- **Apply without showing the diff.** Even if the human earlier said _"just
  apply edits"_ in this session or a previous one — the diff-then-apply
  cadence is per-edit. Standing pre-approval doesn't exist.
- **Fold multiple page edits into a single ask.** If a Design task touches
  three arch pages, that's three separate diff-then-apply rounds — not one
  bundled _"apply all three"_. Each gate is real.
- **Edit a page outside the task's `Notion pages affected` list** without
  surfacing it first. Even if the edit feels "consequential" — _especially_
  then.
- **Use** `mcp__claude_ai_Notion__notion-search` **as the page-read step.**
  Search excerpts are truncated; the diff will be wrong. Always
  `notion-page.mjs` (or the cached body).
- **Edit a context page in `low` architectural-control mode.** Propose the
  diff as a comment / routed change to the page owner; don't apply.
- **Write to a Notion context page for a `store`-sourced task.** The store is
  canonical for a migrated project — a Notion edit there is invisible to
  every session that reads via the store and silently diverges from what's
  actually authoritative. Stage an `arch.*` intent (Procedure C) instead,
  even if it feels faster to just edit the page you already have open.
- **Apply an `arch.*` intent directly instead of staging it.** These MCP tools
  stage; they never apply. Applying is the operator's step through the
  decision surface — reporting a staged intent as already live is exactly
  the kind of unverified claim the completeness-critic pass exists to catch.
- **Guess a `baseVersion` instead of re-fetching it.** A stale-version stage
  is rejected at apply time by design (`StaleArchUnitVersionError`) — that's
  the safety net, not a bug to route around by pre-computing what the version
  "should" be.

---

## Failure modes (one-liners)

- _"I'll just append a note and they'll see it later."_ → No. Diff-then-apply.
- _"The diff is too long to show in chat."_ → It is exactly that long because
  the change is exactly that big. Show it, paginate the message if needed.
- _"The page is messy; I'll clean up the surrounding section while I'm there."_
  → That's a separate change. File it; don't fold.
- _"The human approved a similar edit last session."_ → That was that session.
  Sign-off is per-edit, scoped to this session.
- _"The project's migrated, but the Notion page is right there — I'll just
  update both to be safe."_ → No. Writing both is the one thing the
  per-project branch forbids; the store is canonical, full stop.
- _"The intent is staged, so the decision is applied."_ → No. Staged means
  waiting on the operator. Report it as staged.
