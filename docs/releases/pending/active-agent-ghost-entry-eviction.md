# Evict activeAgent ghost entries — snapshot no longer grows without bound

## What

`swarmState.activeAgent` (and, on two leak paths, `swarmState.delegationChains`)
now follows the same eviction lifecycle as `agentSessions`:

- `sweepStaleSessions` deletes the evicted session's `activeAgent` entry
  alongside its `delegationChains` entry (previously only the chain was
  dropped, leaving a permanent ghost `activeAgent` entry per evicted session).
- `endAgentSession` deletes the session's `activeAgent` and `delegationChains`
  entries alongside the `agentSessions` entry (previously both satellite maps
  were orphaned; orphans are unreachable by the sweep, which iterates
  `agentSessions`, so they persisted until process exit).
- `rehydrateState` restores `activeAgent` / `delegationChains` entries only
  for session IDs actually restored into `agentSessions`, so ghosts already
  persisted in `.swarm/session/state.json` by older builds are purged on the
  next plugin load instead of being resurrected forever.
- `/swarm reset-session` clears `activeAgent` alongside `agentSessions` and
  `delegationChains` (previously it left every `activeAgent` entry orphaned).
- The `/swarm close` summary line now reads "Cleared agent sessions,
  delegation chains, and active-agent mappings" — close already cleared all
  three via `endAgentSession`/reset; the line previously under-reported it.
  The `/swarm reset-session` and `/swarm finalize` command help text lists
  active-agent mappings for the same reason.

## Why

The snapshot writer re-serializes every `activeAgent` entry to
`.swarm/session/state.json` on every `tool.execute.after`. With no eviction,
the map grew one ghost entry per evicted/ended session, across restarts,
without bound — a production snapshot carried 69 `activeAgent` entries against
23 (pruned) `agentSessions`, 46 of them ghosts. Whole-map consumers (e.g. the
curator model-resolution heuristic scan) saw mostly dead sessions.

Verified against that real snapshot: after this change a load → write cycle
drops `activeAgent` from 69 entries to 23 (exactly one per live session) and
the ghost entries never return. Every production path that removes an
`agentSessions` entry (stale sweep, `endAgentSession`, `/swarm
reset-session`, full reset) now removes the matching `activeAgent` entry in
the same pass, so the map stays in lockstep with `agentSessions` (transient
in-turn divergence aside), whose size the 2-hour idle TTL sweep already
bounds (AGENTS.md invariant 8).

## Migration

None. No schema change — older snapshots load as before; their ghost entries
are simply filtered on rehydration and disappear from the next written
snapshot. Rehydration runs at plugin init, before any turn is in flight; a
session that resumes afterwards gets its `activeAgent` entry re-established
by chat.message (delegation-tracker), and until then every point reader
falls back to the orchestrator name — the same treatment a fresh process
gives an unknown session.

## Caveats

- Per-session `delegationChains` arrays remain uncapped within a single live
  session (entries are appended on agent switches). Production data shows
  single-digit chain lengths; the array is reclaimed with the session at the
  2-hour idle TTL, at `endAgentSession`, or on `/swarm reset-session`, so no
  cap was added.
- Dropping ghost `delegationChains` on rehydration slightly tightens the
  `update_task_status` QA gate's unscoped reviewer/test-engineer detection:
  a chain from a session that no longer exists can no longer satisfy it.
  This is fail-closed (the gate asks for a fresh reviewer run instead of
  accepting a dead session's evidence); the production snapshot contained
  zero ghost chains.
- A subagent turn that stays silent past the 2-hour session TTL between two
  tool calls now loses its `activeAgent` entry along with its (already
  evicted, pre-existing behavior) session state, so its next tool call runs
  under the orchestrator identity until the next chat.message. Previously a
  ghost entry masked this for the first few seconds of the recreated
  session; the recreated session's `delegationActive: false` forced the same
  convergence regardless.
