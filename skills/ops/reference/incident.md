# Incident sub-protocol

An **ops run that uncovers a live production incident** (a crash-loop, a deadlock, a stalled
pipeline degrading prod *right now*) switches out of task-working and into this protocol. It was
improvised correctly once (a 3-hour L1 deadlock, 2026-07-04); it should never be improvised again.

The governing insight: **a restart destroys the evidence that explains the incident.** A stack
dump, the live lock graph, in-flight query states — all gone the instant you bounce the process.
So evidence capture is *ordered before* any recovery action, and recovery itself is gated.

## The five steps, in order

1. **Freeze.** Stop working other tasks. Stop poking the affected component. Do **not** start
   restarting things to "clear" it — a restart both destroys evidence (step 2) and, if you loop on
   it, masks a real bug as a flaky one.

2. **Capture volatile evidence — BEFORE any restart.** This is the irreversible step; get it
   first. Capture whatever the incident is about, read-only, through the project's sanctioned
   surfaces:
   - a **stack dump** of the stuck process (e.g. `py-spy dump`, a thread dump) — destroyed by restart;
   - the **lock / activity graph** (e.g. `pg_stat_activity`, blocking-lock queries, thread-wchan);
   - the relevant **logs, metrics, and queue/backlog depths** at the moment of the incident.
   Save it into the staging journal (`evidence[]`, `state: incident-frozen`) so it survives context
   loss. If a needed diagnostic isn't installed on prod, note it as a **standing-toolkit gap to
   file** — install it only if you must to capture, and record that you did.
   > **Verify the diagnostic's binary path before you need it — it may be installed per-user, off
   > the runtime user's PATH.** A tool can be present yet invisible to the account you'd run it as
   > (a `sudo -u <svc>` invocation won't find it; attaching to another user's process may also need
   > root for ptrace). Don't discover this mid-incident — the project's `context.md` should record
   > the exact path + invocation (e.g. polimarket's py-spy is a per-user install under `/home/…`,
   > run by full path as root).

3. **Classify recovery risk — and hand the risky part to the operator.** Decide what recovery
   *would* be, and who may do it:
   - **Safe, in-scope, read-only-adjacent:** fine to note and, in interactive context, do with the
     operator watching.
   - **Prod-mutating recovery — the *decision* is the operator's, the *execution* is yours**
     (interactive, under phase auth): a fleet/daemon restart, a `pgbouncer` bounce, killing a
     session, a service restart. Present the options, get the operator's **decision**, then **you**
     run it — **never hand the command back to an operator who has no server access** (the co-hosted
     norm; they decide, you execute). In autonomous context you **stop here** and escalate; you do
     not execute it.

4. **File the bug(s).** The incident is a symptom — file 🔲 Backlog task(s) for the *root cause*
   (and any contributing gap, e.g. a missing seed, a missing diagnostic on prod). Attach the
   captured evidence / journal reference. Accurate-the-first-time: root-cause from the evidence
   before assigning severity.

5. **Don't loop on the workaround (don't recover-in-circles).** Never keep restarting to paper over
   the incident — **while the root code bug is still live the incident recurs, and each restart
   leaves the fleet in a more unknown state** (killing a stuck session/backend to clear a lock is
   pointless if the bug that took the lock is still running). Each loop also destroys more evidence
   and normalizes a live bug. **Capture + file the fix** — one captured, escalated, filed incident
   beats ten silent restarts.

## Autonomous vs interactive

- **Autonomous:** freeze → capture → **escalate + notify** (surface the incident, the captured
  evidence, and the exact recovery step you would recommend) → file the bug(s). **Do not perform
  prod-mutating recovery.** Record everything in the journal as `incident-frozen`.
- **Interactive:** the same, but recovery becomes a live operator decision — present the captured
  evidence and the classified recovery options; the operator chooses and authorizes; you execute
  only what they authorize, then confirm the component recovered and file the follow-ups.
