# Presentation — Step 2 & Step 3 detail

How to present prioritization (Step 2) and per-question debate (Step 3). The
goal: the human can debate the proposed order and lock each decision from your
message alone, without re-reading the task body, the code, or the arch pages.

---

## Step 2 — Prioritization

### Hard rule

`depends_on` chain. A Design task whose deps aren't at ✅ Done or 🗂️ Ready
**does not appear in the executable order** — it goes to the **Blocked**
sub-list with the un-Ready dep ID(s) annotated. The skill never proposes an
order that violates the dep chain.

### Heuristic axes (debate expected)

These shape the proposal; they do not bind it. The human reshuffles freely.

1. **Theme cohesion.** Group tasks that touch the same area:
   - Same Notion arch page in their `pages_affected` list.
   - Same `source_root` package in their theme tags.
   - Same downstream Code-task chain (one's follow-on tasks will be the next's
     deps).
     A theme cluster lets a sequence of decisions land consistent — you stay
     loaded on the same constraints across multiple tasks.

2. **Size balance.** Open-question count is the cheap size proxy. A milestone
   with five 1-question tasks and one 6-question task reads better interleaved
   than front-loaded. Interleave when the dep graph allows it.

### Priority tags as tiebreaker only

🔴 High > 🟡 Medium > 🟢 Low is a tiebreaker between otherwise-equal slots.
Don't make Priority the ordering axis — the project's Priority discipline is
loose enough that it would mislead.

### Notes from the task body

The body sometimes carries inline sequencing hints like _"Pick up last in M9"_
or _"Best validated after task X lands"_. These are **stronger signals than the
heuristics** but **weaker than the depends_on chain**. Surface them explicitly
in the proposal.

### How to present

```
**Group A — L2 meta-analyzer coverage** (2 tasks · 5 open questions)
Why together: both lock the (meta-analyzer × L1-signal) coverage matrix.
The first's locked spec is the second's input.

  ① Design: L2 meta-analyzer signal coverage (3 open questions, 🔴 High)
  ② Design: cross-source consistency widening (2 open questions, 🟡 Medium)

**Group B — frontend serving topology** (1 task · 2 open questions)
Why solo: orthogonal to A; no shared code region or arch page.

  ③ Design: frontend serving — bundled vs split? (2 open questions, 🟡 Medium)

**Blocked (deps not Ready)**

  ④ Design: market↔match linkage post-tz-fix — waits on 38522f91-…-81dd (Ready)
    and 38522f91-…-8180 (In Progress). Currently 🔴 High but blocked.

**Body hints noted**

  ⑤ "Pick up last in M9" — task ⑥ (kept at the end of Group A's tail).

This is the proposed order. Push back, regroup, or approve.
```

End **exactly** with: _"This is the proposed order. Push back, regroup, or
approve."_

### Iteration

The human will push back. Common pushbacks:

- "Move ② before ① — its decision actually constrains ①."
- "Group A and B aren't orthogonal — ③ also touches the L2 page."
- "Skip ④ entirely; the deps won't land this milestone."

For each pushback:

- Acknowledge briefly.
- Re-propose the corrected grouping in full (don't make the human reconstruct).
- Ask the same closing question.

Only proceed to Step 3 once the order is signed off. The signed-off order is
recorded informally (no separate state file needed — the order is recoverable
from `design-state.json` by following `moved_to_in_progress_at` timestamps).

---

## Step 3 — Per-question cadence

One open question per message. This is the most important rule in the skill.
Batch-locking is the single highest-leverage failure mode it prevents.

### The 5-part question message

```
**Task: <task title>** · Question N of M

**The question** (verbatim from task body)
> <quote the question exactly as written — preserve the bold/italics if any>

**Investigation**
- <2–4 bullets — what the code says, what the API returned, what the arch
  page constrains. Cite paths and page sections.>
- e.g. `l2_runner.py:112` hardcodes `analyzer_id="lead_lag_v1"`.
- e.g. Analysis Layer Outputs page § "L2 meta-analyzers" says cross-cohort
  comparisons "should generalize beyond lead/lag where the L1 signal carries
  windowed structure".

**Options**

- **A — <short name>.** <one-line answer / what the option does>
  - **+** <pro>
  - **−** <con>
- **B — <short name>.** <one-line answer>
  - **+** <pro>
  - **−** <con>
- **C — <short name>.** <one-line answer — only if there's a meaningful third>
  - **+** <pro>
  - **−** <con>

**Recommendation**
<One sentence: my pick, with the load-bearing reason in a clause.>

**Debate this — where am I wrong?**
```

**Why this exact structure for Options:** each option must be a top-level bullet
with the pros/cons as nested bullets — _not_ a flat `A. … / + … / − …` with
indented continuation lines. Flat-with-indent collapses in CommonMark and the
terminal renderer: sibling options get absorbed into the preceding bullet's
continuation, and the rendered output reads as one tangled list where B and C
appear _inside_ A. The bullet-list-with-nested-bullets shape renders three
distinct option blocks reliably. Always blank-line before the `**Options**`
heading so the list starts cleanly.

### Rules for the question message

- **Quote the question verbatim.** Don't paraphrase. Decisions get re-read months
  later; the human needs to match your locked decision to the original wording.
- **Investigation cites real evidence.** File paths with line numbers; arch-page
  section headings; cached API-shape snapshots. No "the code probably does X" —
  if you're not sure, the investigation isn't done.
- **2–3 options is the sweet spot.** One option is a foregone conclusion (just
  recommend, no options). Four or more is decision-paralysis bait — fold the
  weakest into a con on a neighbour.
- **The recommendation is your judgment, not a summary.** Pick one, say so,
  give the one-line reason. If you genuinely cannot pick, that itself is a
  finding — say so and ask the human to decide directly.
- **Close with the literal phrase.** _"Debate this — where am I wrong?"_ The
  phrase signals expectation-of-debate; a softer ask gets less pushback.

### Iteration before lock

Expect debate. Some common patterns:

- _"Your investigation missed X."_ → re-investigate, re-present the question
  with X folded in. Don't argue from your original framing.
- _"Option B's con isn't actually a con."_ → acknowledge if true, update the
  recommendation if it flips.
- _"There's a fourth option you didn't consider."_ → add it, re-present.
- _"That's a Liquipedia-convention artifact, not corruption — and Liquipedia
  times shouldn't be load-bearing anyway"_ (reframe + new assertion in
  confident-tone) → **investigate the assertions before doing anything else.**
  Reframes carry premises; the premises must be verified before they can become
  premises of the next recommendation.

### Iteration is not sign-off

The single most subtle failure mode in this cadence: treating the human's
debate content as the sign-off itself. Pushback that adds new content — a
reframe, a counter-assertion, a missing premise, an unconsidered option — is
**iteration data**. It is the opposite of approval; it is _"go do more work."_

When the human's reply contains novel claims you haven't yet investigated, the
correct move is always: investigate → re-present → ask for sign-off **again**.
Never paraphrase the pushback into a "locked" entry. The diagnostic test: if
your next message starts with _"Locked. Recording the human's framing…"_ and
the human's prior message contained any factual claim, recommendation reframe,
or strategic redirection you did not investigate, **you are about to commit
this anti-pattern**. Stop, undo any stamp, run the investigation, re-present.

A sign-off is explicit approval of a recommendation **you** presented — not a
synthesis of content the human just introduced. Approved phrasings: _"lock A"_,
_"go with B"_, _"your recommendation"_, _"ship it"_, _"yes, that one"_. **Not**
approved: a substantive reply that happens to end (or be tonally framed) like
a verdict. When in doubt, ask: _"To confirm — should I lock the original
recommendation, the reframed version you just described, or do you want me to
investigate first?"_ The question itself prevents the failure.

Iterate until the human signs off explicitly. Do not auto-lock on silence,
on _"ok"_-without-context, or on a substantive reply paraphrased into a lock.

### Recording the lock

On explicit sign-off, write to `design-state.json` (the loader-seeded file):

```json
"<task-id>": {
  ...
  "open_questions": [
    {
      "q": "<verbatim question>",
      "investigated": true,
      "recommendation": "<your one-line pick>",
      "locked_decision": "<the human's chosen option, paraphrased to a one-liner>",
      "signed_off_at": "<iso-8601 UTC>"
    }
  ]
}
```

Confirm in chat _"Locked: <one-liner>"_ before moving to the next question.

### After every question is locked

Compose the **Implementation notes draft** in chat — do not write to Notion
yet. Show:

1. **Decision summary** (one paragraph).
2. **Open questions resolved** table (only if ≥2 questions; mirror the
   MCP-Slice-2 reference closure):

   | Question          | Locked answer   |
   | ----------------- | --------------- |
   | <1-line question> | <1-line answer> |

3. **Notion pages updated** (filled in as Step 3.4 progresses, or marked
   _"pending — see next messages"_).
4. **Follow-on tasks filed** (same, or _"pending"_).

Ask: _"This is the Implementation notes draft. Apply it, then move on to the
page edits / follow-on tasks?"_

The human's _yes_ unblocks Step 3.4 and 3.5; the actual write to the Design
task body happens last, after pages and tasks are in place (so the task body
references the real new Notion IDs, not placeholders).
