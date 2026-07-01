# Planning-system residual hardening (#660, #1267, #1269, #1270)

## What changed

A batch of planning-system correctness and hardening fixes, resolving the
residual findings left open across four tracking/bug issues. Most of the
original #660 audit findings (F-03/F-05/F-06/F-07/F-09/F-12) were already
fixed in earlier releases; this change closes what genuinely remained.

**Plan/markdown sync (#660 F-11).** `isPlanMdInSync` no longer treats a
`plan.md` that merely *contains* the expected rendering as a substring as
"in sync". A non-equivalent `plan.md` is now reported out of sync, so the
authoritative `plan.json` is re-projected instead of silently trusting a
stale or partial markdown file. The legitimate paths (PLAN_HASH header match
and exact normalized equality) are preserved.

**Last-resort phase-completion write (#660 F-08).** When `phase_complete`
falls back to its emergency direct write of `plan.json` (plan unloadable and
no ledger present), the write is now validated against the plan schema before
persisting and records a traceability event to `.swarm/events.jsonl`, in
addition to the existing atomic temp+rename. A fallback completion is no
longer invisible to a later audit.

**Single source of truth for plan-id derivation (#660 F-14).** ~15 test
files that re-implemented the `plan_id` formula inline now import the
canonical `derivePlanId` from `src/plan/utils.ts`. Four of them used a
divergent regex (`/\W/g`, which stripped the joining hyphen) that could
disagree with production's canonical derivation; they now match exactly.

**Regression guards (#660 FR-004).** New tests pin three previously-resolved
fixes so they cannot silently revert: `phase_complete` acquires the
`plan.json` lock before `savePlan` (F-03), the council stores write
atomically (F-05), and the file-lock retry/backoff configuration stays in
place (F-09).

**Structured staleness signal (#1269).** When the plan loader detects that
`plan.json` is unrecoverably stale (hash-mismatches the ledger, ledger replay
fails, and no critic-approved snapshot exists), it now records the workspace
and attaches a runtime-only `_ledgerReplayStale` flag to the loaded plan
(mirroring the existing `_specStale` overlay). Because the expensive detection
is startup-gated, the verdict is *persisted per workspace* and re-surfaced on
every subsequent load, so `update_task_status` and `phase_complete` reliably
see it in long-lived hosts (not just on the first load) and refuse to mutate a
known-stale plan with actionable recovery guidance instead of relying on a
logged warning. It self-heals: once `plan.json` and the ledger reconverge
(e.g. an architect `save_plan`), a cheap hash recheck clears the verdict on the
next load — the refusal lasts only until the workspace actually recovers. The
flag is never persisted to disk and never affects plan hashing.

**Idle session reclamation (#1269).** Accumulated session state is now
reclaimed by an opportunistic, cooldown-bounded sweep that runs off the
per-tool-call path, independent of a new session starting. Previously stale
sessions were only evicted when a *new* session began (or at `/swarm close`),
so a long-lived host could accumulate sessions indefinitely. No timer is
introduced (respecting the bounded-init contract).

**Concurrency + traversal correctness (#1267).** Investigated the reported
update-task-status test failures: the "multiple lock winners" tests encoded
the obsolete `retries: 0` lock behavior — under the current retry/backoff
config, contending callers serialize on the `plan.json` lock and each
read-modify-writes fresh state, which is correct (no lost update, no bypass);
those tests were corrected to assert serialization safety. A genuine
Windows-only path-traversal gap was fixed: `resolveWorkingDirectory` detected
`..` segments by splitting on `path.sep` (`\` on Windows), so a
forward-slash traversal evaded detection — it now splits on both separators.

**Defense-in-depth hardening (#1270).** `validateSwarmPath` now resolves
symlinks (realpath) before its `.swarm` containment check, closing a gap
where a symlink inside `.swarm/` pointing outside passed validation.
`version-check` strictly validates the registry response (JSON content-type,
bounded length, strict semver) before use. `composeHandlers` gained a
fail-closed brand guard so a handler marked fail-closed cannot be silently
composed onto the error-swallowing path.

## Why

These are correctness, security, and observability fixes in the planning
subsystem — the layer that owns plan-state mutation under file locking.
Each addresses a concrete gap: silent stale-state propagation, an invisible
emergency write path, a cross-platform traversal-detection hole, a symlink
containment gap, and unbounded session growth in long-lived hosts.

## Migration steps

None. All changes are backward-compatible. The `_ledgerReplayStale` flag is
runtime-only and not part of any persisted or hashed shape.

## Breaking changes

None.
