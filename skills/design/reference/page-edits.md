# Architecture-page edit protocol

The single most reversible-but-easy-to-skip step in the skill. The 7 context
pages and the Future Scope page are load-bearing for every downstream session —
silent edits there are the most damaging mistake a Design Execution session can
make. This protocol exists to make silent edits impossible.

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

## Two sub-procedures

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

The "after" anchor is the load-bearing detail. _"Add a section about X"_ is
ambiguous about placement; _"after § 'L2 meta-analyzers'"_ is not.

---

## Quoting context

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

## Decisions about which page to update

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

---

## Failure modes (one-liners)

- _"I'll just append a note and they'll see it later."_ → No. Diff-then-apply.
- _"The diff is too long to show in chat."_ → It is exactly that long because
  the change is exactly that big. Show it, paginate the message if needed.
- _"The page is messy; I'll clean up the surrounding section while I'm there."_
  → That's a separate change. File it; don't fold.
- _"The human approved a similar edit last session."_ → That was that session.
  Sign-off is per-edit, scoped to this session.
