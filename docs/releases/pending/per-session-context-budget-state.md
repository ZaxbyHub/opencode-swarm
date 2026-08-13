# Context-budget state is per-session, and a budget failure no longer takes other injections with it

## What

Turning the context-budget check back on (#2119, #2129) made two latent defects reachable.
Both are fixed here.

**1. The budget reading leaked across sessions.** `swarmState.lastBudgetPct` and its
denominator `lastBudgetTokens` were bare module-level scalars shared by every session in
the plugin process. That was harmless only while the budget check threw on every call and
left them pinned at `0`. Now that the check runs, the last session to transform overwrites
them for everyone, and the consumers act on whatever they find:

- `compaction-service` is enabled by default and evaluates after **every non-fast tool
  call of every agent**. A busy session reporting 85% would fire the emergency tier inside
  an unrelated, small session — and because that service keys its *hysteresis* per session,
  the wrong session's state machine advanced on another session's number.
- The `>= 50%` CONTEXT PRESSURE advisory was delivered to whichever session happened to
  make the next tool call.
- `/swarm status` could pair a percentage from one report with a denominator from another,
  which is exactly the mismatch the denominator was added to prevent.

They are now one per-session record, `lastBudgetBySession`, keyed by `sessionID` and
FIFO-capped (AGENTS.md invariant 8). The pct and its denominator are written together in a
single `setSessionBudget` call, so they can never be paired across reports. Consumers that
*act* on a session read `getSessionBudgetPct` / `getSessionBudgetTokens`; `/swarm status`,
which has no single session in scope, uses `getDisplayBudget()` — documented display-only,
returning the most-pressured session's pct **and its own denominator** as a pair.

**2. A budget failure silently removed unrelated injections.** Neither budget block was
guarded, so anything thrown inside escaped to the hook-level catch at the bottom of the
system-enhancer transform, skipping every remaining statement in that branch — the
pre-flight binary advisory, the `coder`/`test_engineer` environment-profile injection, and
the Path A unified-budget finalize. Both blocks now carry their own scoped `try/catch`
with a debug-gated warning, matching the optional injections that follow them.

**3. The budget warning was invisible to the budget it reports on.** Every other injection
is metered through `tryInject`, which accumulates `actualDemand`; the warning used a raw
`output.system.push`. Its tokens are now added to `actualDemand`. It is still deliberately
*not* routed through `tryInject` — dropping an "out of budget" notice because you are over
budget is the wrong failure mode — but the unified ledger that sizes the knowledge
injector's share is no longer under-reported at exactly the moment context is tightest.

## Migration

None. No configuration changes, no schema changes, no API surface a consumer repository
depends on.

## Notes

`resetSwarmState()` clears the new map, so `/swarm close` and test isolation behave as
before. A regression test asserts that a session at 85% does not compact a different
session; it fails if the consumer is pointed back at any cross-session aggregate.
