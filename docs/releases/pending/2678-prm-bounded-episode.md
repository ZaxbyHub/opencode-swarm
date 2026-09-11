# Give repeated PRM stops a bounded episode and terminal recovery state (#2678)

## What

The PRM hard stop is no longer an unbounded loop. Each escalation ladder (one
`pattern|target` identity, or bare `pattern` for a growing target set) now runs
a bounded episode state machine — `none -> hard-stop -> terminal (handoff)` —
in `src/prm/escalation.ts`:

- The `prm_hard_stop` TRIGGER telemetry fires exactly once per episode, on the
  false-to-true transition (previously it re-fired on every count>=3
  detection: 5 detections produced 3 triggers and an endless stop loop).
- The first repeated stop escalates the episode to its TERMINAL/handoff state:
  the new `prm_hard_stop_terminal` telemetry event fires exactly once, the
  `[HARD STOP (TERMINAL — HAND OFF)]` advisory is delivered once through the
  existing guidance carrier, and the deny/inject one-shot tokens are NOT
  re-armed afterwards — the loop ends and the operator owns the outcome.
- A 15-minute cooldown absorbs further detections of the same ladder (no count
  advance, no telemetry, no re-arm); after it lapses the episode resets with
  the ladder count preserved, so a genuinely continuing pattern re-escalates
  through a fresh episode and fires the trigger again on the new transition.
- `clearAction(match, owner?)` is the action-local corrected-success clear: it
  removes ONLY the matching ladder (count, episode record, and the one-shot
  stop token it armed) and leaves unrelated ladders untouched. An owner token
  `{ sessionId, generation }` is audited: stale generations and foreign
  sessions fail closed; only the exact current session AND generation
  succeeds. `reset()` remains the whole-tracker delegation/new-session
  boundary.
- A `generation` counter advances on every episode-state transition and is
  mirrored onto the session (`prmEpisodes`/`prmEpisodeGeneration`, in-memory
  only) so a mid-session tracker rebuild restores the episode keyspace.

Operator controls stay reachable by construction: after the terminal
transition nothing re-arms the deny token, so read/diagnose/rescope/repair/
handoff/abort paths all remain open. The three counters — trigger
(`prm_hard_stop`), delivery (`prm_hard_stop_delivered`), terminal
(`prm_hard_stop_terminal`) — are documented in `docs/configuration.md` as
noninterchangeable, with historical trigger totals explicitly qualified as
descriptive, never causal failure-rate evidence.

## Why

Issue #2678 (Workstream A, PR 12 of 12): the source-confirmed third-and-later
PRM escalation repeatedly set `hardStopPending` with no bounded episode or
terminal recovery state, and `reset()` cleared the entire tracker rather than
the matching action — reproduced live at base with 7 same-ladder detections
producing 5 trigger firings and no exit except an external reset.

## Migration

No configuration changes; all behavior is automatic. Observable changes: one
trigger telemetry event per episode (not per detection), a new terminal event
and TERMINAL advisory at the bound, and no stop re-arming after the terminal
transition until cooldown lapse or an owner-verified corrected-success clear.
Tests: new `src/prm/__tests__/issue-2678-bounded-episode.test.ts`; exactly two
defect-pinning assertions in `escalation.test.ts` updated to the bounded
protocol (the 4th+ re-fire and the flag-exposure assertions); the telemetry
catalog/event-contract/envelope surfaces were extended for the 64th event kind.
