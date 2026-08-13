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

  Three defects found reviewing that change are fixed with it. The advisory
  dedupe key was still scoped to the pattern type, so with every target at level 1
  exactly **one** advisory was delivered per pattern for the whole session and
  every later target's guidance was dropped — the agent was neither stopped nor
  told; it is now scoped to the ladder (40 distinct repeating files: 1 advisory
  before, 40 after). `detectRepetitionLoop` recovered its `(agent, action, target)`
  tuple with `key.split('|')`, truncating any target containing a pipe — and since
  targets are now whole shell commands, `bun test 2>&1 | head`, `| tail` and
  `| wc -l` all collapsed onto one ladder and hard-stopped in six steps; the tuple
  is now carried rather than re-split. And the ladder map is bounded at 256 with
  FIFO eviction, matching the episode ledger it mirrors.

  **Known trade-off:** a pathology spread thinly across many targets no longer
  reaches a hard stop. This is inherent to the precision/recall trade the issue
  asks for — a benign eight-module coder loop and a distributed ping-pong are
  numerically identical (16 vs 15 ladders, each struck once), so no spread
  threshold separates them. The agent is advised per distinct behaviour instead of
  being blocked.

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

- **Trajectory entries no longer persist secrets in command values.** Widening
  `target` from a first word to a whole 200-char command widened what
  `.swarm/trajectories/*.jsonl` and evidence/replay store, and the existing
  redaction only matched sensitive KEY names — useless for
  `curl -H "Authorization: Bearer …"`, where the secret is the value. `target`,
  `args_summary`, `intent` and the `description` fallback now all run the shared
  `redactSecrets` detector plus a module-local URL-credential pattern, over a
  bounded 4 KB scan window (the shared detector's lazy private-key pattern is
  quadratic against repeated unterminated `BEGIN … PRIVATE KEY` markers, and this
  runs on the per-tool-call path).

  Ordering is load-bearing: the command is **bounded first, redacted second**.
  Redacting first was a defect caught in review — a placeholder is longer than
  the span it replaces, so redaction pushed a ~200-char command's tail past the
  bound and truncation cut the part that made two commands *different*,
  collapsing them onto one target even when the secret was not the differing
  text. That is the same false-`repetition_loop` failure this issue exists to
  close. When redaction still overflows the bound, the target carries a digest of
  the bounded raw command so distinctness is preserved by construction.

  The URL-credential pattern is deliberately local to the trajectory logger:
  `SECRET_PATTERNS.length` in `src/memory/redaction.ts` feeds
  `computeRedactionPolicyVersion`, a memory-cohort compatibility value that fails
  closed, so growing that array would invalidate every already-linked cohort.

- **Episode-ledger eviction is now least-recently-struck.** `Map.set` on an
  existing key preserves its original position, so the 256-entry FIFO bound
  evicted by oldest-first-seen and could drop the very episode an agent was
  actively tripping. Delete-then-set moves a re-struck episode to the back.

## Docs

`docs/configuration.md` now documents how the ladder counts, and how to clear a
stuck escalation (`/swarm reset-session`, or simply a new delegation).
