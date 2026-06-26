# Low architectural-control adaptation

Read this when `manifest.architectural_control` is `low`. The variable that changes
grooming is **architectural control, not the backend** — Jira-at-a-company is just
where low control usually shows up; the same applies to a Notion project you don't
own.

**Through-line: grooming moves from _decide-and-rewrite_ to _investigate-propose-route_.**
You are one contributor among many. You do not own the design docs, you cannot
resolve every open question, and you do not rewrite issue descriptions or impose waves.

The seven shifts:

1. **Context loading** — from "fetch my authoritative docs" to "discover the
   read-only sources of truth (Confluence / ADRs, the Epic description, CONTRIBUTING /
   linters / CI, existing code conventions) and **explicitly record the gaps you can't
   fill**."

2. **Open-question triage by decider** —
   - _Bucket A_ (self-resolvable from code you can read + a local, reversible default)
     → decide and proceed.
   - _Bucket B_ (cross-team contracts, public APIs, data models, security, priority,
     unstated conventions) → **route to the owner**.
     The bias inverts to propose-and-route for anything architecture-touching.

3. **Readiness gains a "blocked on external decision" state** — Ready = all Bucket A
   resolved **and** every Bucket B has an owner + an answer. This is distinct from
   "blocked on a dependency task."

4. **Rewrite → annotate** — when the issue Description is owned by a PM / reporter,
   groom via a scoping **comment** + well-scoped **sub-tasks**, not a rewrite. Respect
   Description ownership.

5. **Waves & Epic structure become advisory** — propose the `is blocked by` graph /
   wave grouping; the issue owners apply it. Respect sprint boundaries and the team's
   backlog ordering.

6. **Defer to the team's Definition of Ready/Done** — layer the orchestrator's
   dispatchability needs (scoped, testable AC, deps modeled, status in the ready set)
   **under** the team's existing DoR; don't replace it.

7. **Distributed sign-off** — route by owner (tech lead / assignee for technical
   scope, PM for priority / inclusion). Don't assume a single approver.

Everything else — the deterministic load, the cached code reads, the 4-point
presentation, never-silently-widen, defer≠resolve — still applies.
