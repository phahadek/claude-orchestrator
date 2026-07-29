# Injected-procedure instruction style

Canonical style contract for text injected into a dispatched session's
prompt — `procedureCore.ts` (principles, step summaries), `procedureAssembler.ts`
(skeleton, digest), and `gate/gateItemVerifier.ts`'s gate-verify procedure.
Soft, hedged prose is why load-bearing directives get read as suggestions and
skipped under context pressure. This file is the standing rule against that,
not a one-time cleanup note — every future edit to injected-procedure text
follows it.

## Rules

- DO write every load-bearing directive as an imperative bullet — "DO X" /
  "DO NOT Y" — not a hedged sentence ("should", "ideally", "generally",
  "try to").
- DO NOT bury a directive inside a paragraph of rationale. State the
  directive first, in one line; rationale (when genuinely needed) follows
  as a separate sentence or bullet, never as a prerequisite to finding the
  rule.
- DO use an IS / IS NOT (or IS / IS-NOT) list wherever a definition itself
  is load-bearing — i.e. wherever a session must classify something as one
  of two things to decide what to do next (e.g. what counts as "operational
  evidence", what "the terminal action" is).
- DO give the concrete invocation — the exact command, script path, or
  intent-kind payload — for any directive that tells a session to request
  or invoke something. DO NOT describe only the grant/permission model and
  leave the session to reverse-engineer the call.
- DO NOT strip genuine nuance that changes what a session should do in a
  specific situation (e.g. groom's Ready vs. Deferred proposal shapes).
  Tighten how a rule is stated, not what it means — cut hedging, not
  information. A hard rule should read like a hard rule, not like the only
  sentence in the file.

Apply this style to every new or edited injected-procedure directive.
