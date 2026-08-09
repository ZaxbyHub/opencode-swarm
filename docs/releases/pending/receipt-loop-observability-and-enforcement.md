# Knowledge receipt loop: silent-skip observability + non-critical ack visibility

## What

Field analysis of a long-running deployment showed the knowledge learning loop
producing near-zero receipts (26 receipt events across 5,000, all from
reviewer-class agents, zero from coders) with no way to diagnose why from
`.swarm/knowledge-events.jsonl`. Three compounding causes were fixed:

- **Delegate-path skip events** — `injectDelegateDirectivesBefore` (the hook
  that prepends `<delegate_knowledge_directives>` to Task delegation prompts)
  had eight silent early-exit branches that only wrote debug logs. Every
  per-delegation skip branch now also emits a structured `injection_skip`
  event (`delegate_*` reason prefix, agent + session attribution), mirroring
  the #1768 hardening the architect path already had. High-frequency
  non-delegation branches (`not_task_tool`, `knowledge_disabled`) stay
  log-only to avoid event floods.

- **Attributed headroom skips** — the `headroom_budget` context-budget gate
  fired before agent identity was resolved, producing anonymous
  `injection_skip` events (2,063 in the analyzed deployment) that could not be
  tied to any agent. Identity resolution now runs before the gate and the
  event carries `agent`/`session_id` when recoverable.

- **`unacknowledged` receipt events** — the delegate ack contract only bound
  CRITICAL-priority directives, and the analyzed knowledge base had 1 critical
  entry out of 103, so non-critical silence was invisible. The ack contract now
  asks delegates for one marker line per directive of any priority; a shown
  non-critical directive that ends a Task with no ack marker produces an
  audit-only `unacknowledged` event (never mutates outcome/violation counters,
  never satisfies terminal/idempotency checks, never escalates). The
  post-mortem curator now tallies unacknowledged counts per entry so
  "shown N times, unacknowledged M times" is visible instead of silent.

Known limitations (deliberate): `unacknowledged` events are audit-only and are
not folded into the counter baseline, so per-entry unacknowledged tallies reset
when the event log rotates past its FIFO cap; and re-running ack collection
over the same delegation prompt appends duplicate events (same shape as the
pre-existing unacknowledged-critical loop). Batch emission goes through a
single lock/append cycle per delegation.

Note on the widened contract: `KNOWLEDGE_IGNORED` remains a genuine negative
outcome signal (it feeds ranking and quarantine evidence), and asking every
delegate for a marker per directive raises how often it can be filed. The
block text therefore reserves IGNORED for a deliberate decision against a
directive the delegate judged relevant, and steers merely-irrelevant
directives to the neutral `KNOWLEDGE_N_A` — pinned by tests on both the block
text and the counter effect of a filed non-critical IGNORED.

## Why

The learning loop's application layer looked "broken (0 receipts)" in
post-mortems, but the real causes — delegate delivery skips, budget
starvation, and unenforced non-critical acks — were structurally invisible.
This change makes every dark path leave a diagnosable trace and turns
non-critical ack silence into first-class data, without adding any blocking
gate.
