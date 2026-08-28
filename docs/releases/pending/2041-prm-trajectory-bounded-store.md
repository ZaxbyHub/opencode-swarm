# Bounded PRM session trajectories, bounded reads, restart-safe steps (issue #2041)

The PRM session trajectory store `.swarm/trajectories/{sessionId}.jsonl` is now
a bounded store in the issue-#2039/#2040 house pattern. Previously the
production append path (`appendTrajectoryEntry`, called per tool call) never
enforced any disk bound — the exported `truncateTrajectoryIfNeeded` helper had
zero production callers — so an active session's file grew without limit while
only the in-memory cache was trimmed; `readTrajectory` and `getCurrentStep`
full-read the file on every cold start; the 7-day TTL cleanup only ever fired
for sessions that had detected a PRM pattern (its call site sat below the
no-match early return); and process restarts reset step counters to 1,
duplicating step numbers against the persisted trajectory.

One knob now governs both planes: `prm.max_trajectory_lines` (default 1000,
previously unwired — the append path hardcoded 1000 while the schema default
never reached production) drives the in-memory cache trim AND disk compaction,
which retain the newest `floor(maxLines/2)` entries by the same rule. A
sovereign byte ceiling `max(64 KiB, maxLines × 512 B)` is checked on EVERY
append (the file stat needed for torn-tail re-framing doubles as the size
probe) and a line-count check runs every 25 appends through a tail-bounded
window read — never a whole-file read. Oversize records (>64 KiB) are skipped
whole. Compaction publishes via the canonical atomic write (PID-scoped tmp +
rename) and then ratchets a `{sessionId}.jsonl.meta.json` checkpoint whose
`highestStep` can only rise (`max(previous, observed)`), so the step
high-water mark survives even a fully-corrupt data file.

Readers are bounded and honest: `readTrajectoryWithCoverage` reads at most a
1 MiB tail window regardless of file size and discloses coverage
(`complete`/`truncated`/`empty`), the count of entries dropped by prior
compactions (from the checkpoint), and malformed/oversize skips;
`getCurrentStep` reads the newest 64 KiB and merges the checkpoint. The PRM
hook's cold start threads the configured budget into the cache population and
logs a partial-window notice; the consensus corpus flips its existing
`truncated` surface for PRM sessions on partial windows (same seam as the
issue-#2038 skill-usage source), with the default coverage verdict in exact
parity with the live reader.

Crash and concurrency safety: every append and compaction holds an exclusive
per-file `{sessionId}.jsonl.lock` (`wx` create, PID, 5-minute mtime
stale-break, 20×5 ms bounded retry), with an in-process per-key chain so
same-process appends never burn the retry budget. Lock exhaustion skips the
append with a warning — telemetry loss is preferred over corruption in this
best-effort store — and is counted into the new counts-only
`trajectory_health` event (never session IDs, paths, or trajectory content).
A crash-torn tail is re-framed on the next append so a mid-line write can no
longer swallow the following entry; corrupt lines are shed and counted at
compaction.

Restart-safe step numbering: the trajectory logger seeds the process-local
step counter from the persisted high-water mark before a session's first mint
(`ensureSessionStepSeeded`, once per session per process, deduped across
concurrent first calls), so a resumed session continues at step N+1 instead of
duplicating step 1; `/swarm reset` invalidates the seed gate so the next mint
re-seeds from disk. `getCurrentStep` — previously exported but never called in
production — now has its first production caller.

Multi-root safety: the trajectory cache, the step counters, and the new seed
gate are all keyed by canonical project root + session id through one shared
helper (`src/utils/canonical-root.ts`; realpath with resolve fallback,
case-folded on Windows), so one plugin module instance serving several project
roots cannot collide — and junction/symlink aliases of one root share one
identity (linked worktrees on Windows are junctions).

Cleanup now actually reaps: the once-per-session trigger moved to the top of
the PRM hook (healthy sessions included, debounced 10 minutes), plus one
bounded `withTimeout` post-resolution pass at plugin load (never on the
`server()` resolution path). The sweep deletes files older than 7 days (mtime
clamped to now, so clock skew can neither immortalize nor flash-delete),
enforces a 200-file per-directory count cap oldest-first (the adversarial
backstop), removes each session's checkpoint with its file, reaps stale
atomic-write `*.tmp` leftovers, never unlinks a live lock, is capped at 256
unlinks per run (converging), and never touches `.swarm/evidence/`. Replay
artifacts (`.swarm/replays/`) get a hard 1 MiB per-artifact cap (skip +
one-time warn at cap) and share the sweep. Replays and trajectories remain
independent best-effort artifacts.

Task-level evidence trajectories (`.swarm/evidence/{taskId}/trajectory.jsonl`,
`src/hooks/trajectory-logger.ts`) are untouched: same writer, same truncation,
same close/archive consumers. The dead `truncateTrajectoryIfNeeded` export is
removed (release note for direct importers: use the append path, which now
enforces the bound itself).

Review hardening (maintainer + swarm review rounds on PR #2395): the usage
ratchet's literal-mention rule is no longer shadowed by import-allowlist
membership and runs as a blocking CI step (matching the #2039/#2040 peer
ratchets); compaction discloses bytes discarded beyond its read window
(`droppedBytes` in the checkpoint — it can no longer report full fidelity
while erasing pre-window history, and the corpus flags such sessions);
per-session cache resets no longer reset other sessions' compaction cadence;
the lock stale-break uses an absolute-delta comparison so a future-dated lock
mtime cannot immortalize it, and a failed lock create cleans up its own file;
the step checkpoint read is byte-bounded like every other read;
`prm.max_trajectory_lines` gains a schema upper bound (10000) so the emergent
per-project footprint cannot be configured arbitrarily large; and the
step-counter generation invalidates the restart-seed gate on any reset, so
`/swarm close` + same-process re-init no longer mints duplicate step 1s.

Known follow-ups (deliberately deferred, tracked in the PR review): a real
two-process lock-contention fixture (current tests exercise the lock protocol
via seeded lock states and same-process concurrency), and a mid-session
`max_trajectory_lines` lowering test (the budget is captured at hook
creation; a config reload applies to new sessions).

Anti-regression: a new `trajectory_health` telemetry event is catalogued (the
50th kind) with producer/consumer/retention ownership; the retention registry
rows for `prm-session-trajectories` and `prm-replays` move to retain-by-design
with explicit budgets and keyspace bounds; and a usage ratchet
(`scripts/check-trajectory-store-usage.ts`, wired into `drift-check` and
`package.json` as `check:trajectory-store`) fails on any new importer of the
store or raw `trajectories/` path literal outside the approved seam, so no
unbounded reader can quietly reappear.
