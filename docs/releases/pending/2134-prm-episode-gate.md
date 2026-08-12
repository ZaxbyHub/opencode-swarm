# PRM: count escalation strikes per occurrence, not per detection (#2134)

## What

A `coder` subagent could be denied on essentially every tool call with

```
🛑 PRM HARD STOP: Pattern escalation maximum reached.
```

including on read-only calls, with no level-1 or level-2 guidance ever delivered.
Reading five distinct files — the most ordinary thing a coder does — was enough to
arm the deny token.

The PRM 3-strike ladder counted **detections** rather than **occurrences**. A
detector re-emits the same ongoing episode on every tool call with a growing end
step: a coder reading one more file extends its single `context_thrash` run, and a
sliding window extends its single `repetition_loop`. The trajectory cursor could
never suppress that, because the episode's end step always advances past it. So
one episode was counted three times and reached level 3 within three tool calls.

Two independent defects produced it, both fixed here.

- **`detectPatterns` in-tick dedup was a no-op for the case it documented.** Its
  key included the volatile `stepRange[1]`, so one repetition episode emitted
  `[1,2]`, `[1,3]`, `[1,4]`, `[1,5]` — four distinct keys, four surviving matches,
  four strikes, and a first-ever occurrence hard-stopping inside a single tool
  call. The key now uses the episode's **start** step; the surviving match keeps
  the widest range.

- **A continuing episode re-struck on every tool call.** `toolAfter` now consults
  a per-session episode ledger (`prmStruckEpisodes`, keyed `pattern|startStep`). A
  match strikes only when it is a new episode, or when its episode has gained
  another full threshold's worth of occurrences since it last struck; at most one
  strike per pattern type is recorded per tick. Suppressed matches are dropped
  completely — no advisory, no telemetry, no replay, and no pattern-persistence
  tally (a single episode previously reached the default `min_support` of 3 on its
  own and promoted a "learned" insight the agent had exhibited exactly once).

**Containment is not weakened, and this is pinned per detector.** Both strike
grounds are load-bearing: only `repetition_loop` and `expansion_drift` advance an
episode's start step as it runs. `ping_pong` pins it at the first delegation,
`stuck_on_test` assigns `cycleStart` once, and `context_thrash` moves `runStart`
only when the monotonic run *breaks* — which a sustained thrash never does. A
start-step rule alone would have let those three strike exactly once and never
reach level 2 or 3. Regression tests drive each of the five detectors to level 3
independently — `repetition_loop` hard-stops at step 6, `context_thrash` and
`expansion_drift` at step 30. `ping_pong` and `stuck_on_test` assert their OWN
strike counts reaching 3 (at steps 10 and 19 respectively) rather than relying on
the `repetition_loop` co-firing that hard-stops those trajectories at step 7 —
otherwise the test would still pass with those detectors fully disarmed.

## Also

- **The ladder counts strikes per behaviour, not per pattern type.** It keyed on
  `match.pattern` alone, so unrelated occurrences accumulated into one count: a
  coder that read-then-re-read three *different* files scored three
  `repetition_loop` strikes and hit the hard stop without having repeated itself
  even twice on any single file. Measured on a realistic read → edit → run-test →
  re-read → re-run-test loop across modules: hard stop at step 11. Now
  `resolveLadderKey` gives a pattern that names a single target its own ladder for
  that target, so the same trajectory never stops and stays at level 1, while
  three strikes against *the same* target still hard-stops at step 6. Patterns
  reporting a growing target set (`context_thrash`, `expansion_drift`) keep one
  ladder for the pattern — a per-target ladder would restart every tool call and
  they could never escalate, the same fail-open shape the per-detector containment
  review caught earlier.

- **Shell commands are no longer collapsed onto their first word.**
  `extractTarget` in `src/hooks/trajectory-logger.ts` returned a bash command's
  first word as the trajectory target, so `bun test src/a`, `bun run lint` and
  `bunx tsc --noEmit` were all the target `bun`. PRM's `repetition_loop` keys on
  `agent|action|target` at default threshold 2, so a coder doing ordinary,
  entirely different work read as the same action repeated. Measured on this repo,
  twelve distinct `bun …` commands hard-stopped the session by the seventh call —
  the reported symptom, surviving every other fix here. The reporter's environment
  is a Python project, where `python` / `pytest` / `pip` collapse identically. The
  target is now the whole whitespace-normalized command, bounded to 200 chars: an
  agent genuinely re-running the SAME command still produces an identical target
  and is still detected.

- **Escalation state now resets at delegation start.** `agentSessions` entries are
  never removed when a delegated session ends (`sessionEnded` clears scope
  bindings only; `endAgentSession` is reached solely from `/swarm close` and the
  Lean Turbo runner), so a coder session that ended with `prmHardStopPending`
  armed left a live deny token behind — and reusing that sessionID denied the next
  delegation's *first* tool call. `taskMetadata` now resets the child session's PRM
  state once per Task dispatch that claims a coder scope binding, guarded on the
  dispatch `callID` because `message.part.updated` fires repeatedly for the same
  part and an unguarded reset would disarm PRM for the whole delegation.

- **`prm.pattern_thresholds.context_thrash` default `3` → `10`** (tuning).
  `detectContextThrash` flags a run of consecutive steps that each introduce a
  brand-new target; three such steps is indistinguishable from an agent reading
  three files, so the old default fired on essentially every healthy coder session
  and told an agent doing nothing wrong to "restrict file access".

## Docs

`docs/configuration.md` now documents how the ladder counts, and how to clear a
stuck escalation (`/swarm reset-session`, or simply a new delegation).
