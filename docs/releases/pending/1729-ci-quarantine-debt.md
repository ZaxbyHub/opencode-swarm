# CI Quarantine Debt Paydown + save_plan Projection Bug

## What

Resolves #1729 — drives every CI test quarantine list to zero by fixing root
causes (never masking), and fixes a production `save_plan` bug that reverted
completed task statuses.

### Production bug fix: save_plan projection precedence (`src/plan/manager.ts`)

`savePlan` was writing the **replayed-ledger** projection to `plan.json`,
discarding disk-truth task statuses preserved in `validated`. When a task's
`completed` status had been written to `plan.json` WITHOUT a corresponding
`task_status_changed` ledger event (e.g. an external editor or a crash-window
write), the replay "didn't know" about the completion and reverted it to a
stale `in_progress`/`pending` — silently undoing completed work on the next
`save_plan` re-call.

The fix replaces the unconditional replay-overlay with a directional
`mergeStatusesTakingPrecedence`: override the validated/disk status with the
replayed status ONLY when the replayed status is strictly more terminal
(`statusRank`: closed ≥ completed > blocked > in_progress > pending). This
preserves BOTH:

- **Scenario A** — a concurrent writer's newer completion (recorded only in the
  ledger because the plan.json update is the LAST step of savePlan) survives a
  stale-caller save.
- **Scenario B** — a disk-truth completion the ledger doesn't know about
  survives a save_plan re-call.

The second `replayFromLedger()` call that discarded `validated`'s preserved
statuses is removed; the merged `projectionCandidate` is written directly.

### macOS quarantine (22 entries → 0)

- `tests/helpers/safe-test-dir.ts` shared helper and ~19 test files now wrap
  `os.tmpdir()`/`mkdtemp` in `realpathSync` so the `/var → /private/var`
  symlink on macOS no longer trips `.swarm` containment guards and repo-graph
  boundary checks.
- `tests/unit/sandbox/executors/bridge.test.ts`: stale assertion updated —
  `MacOSSandboxExecutor` is now implemented (constructs on darwin, throws on
  non-darwin), not "not yet implemented".
- `tests/unit/sandbox/macos.test.ts`: placeholder constructor tests replaced
  with real platform-gated assertions.
- `scripts/check-invariants.sh`: GNU-only `grep -oP` / `\x27` replaced with
  POSIX-portable `grep -Eo` + explicit quote alternation so BSD grep on macOS
  works.

### Windows quarantine (9 entries → 0)

- `tests/unit/cli/install-default-agent-configs.test.ts`: `bun.cmd` (which
  `Bun.spawn` cannot execute without `shell:true`) replaced with
  `process.execPath`.
- `src/worktree/core.ts`: `normalizeGitPath` now realpath-canonicalizes both
  sides of the worktree-collision comparison, so the GitHub `windows-latest`
  RunnerAdmin 8.3 short-name (`C:\Users\RUNNER~1`) vs long-name
  (`C:\Users\runneradmin`) mismatch no longer defeats path equality.
- `tests/unit/full-auto/adversarial-fixes.test.ts`: symlink-bail gated to
  win32 only, so a real symlink failure on POSIX surfaces.
- `tests/unit/tools/repo-map.test.ts`: explicit `fs.utimesSync` with a future
  timestamp after the schema-version mutation write (Windows same-ms writes can
  leave mtime unchanged at FS granularity).
- 4 entries (cli/update-command, save-plan-adversarial,
  pre-check-batch-sast-preexisting, destructive-command-guard) re-triaged and
  found already portable.

### Integration quarantine (11 entries → 0)

- 2 entries (`save-plan-round-trip`, `plan-status-preservation`) definitively
  fixed by the production bug #1 fix above.
- 9 entries re-triaged and pass on a Windows host; un-quarantined with the
  merge_group ubuntu run as the authoritative validation tier (per the issue's
  §5 methodology). If any file fails on a future ubuntu merge_group run, it
  should be re-quarantined narrowly — not blindly.

### Coverage gate

The coverage job (structurally fixed in #1726 to run each file in its own
`--isolate` process) is exercised by this PR's merge_group run. **Promoting
`coverage` to a required check (ruleset `17809658`) is a post-merge follow-up**
— the issue §2.5 explicitly requires this be done AFTER landing on main to
avoid blocking other open PRs.

## Why

CI had been "green by not running" — honest exit-code detection (#1700)
surfaced a backlog of pre-existing failures that were then incrementally
quarantined. This PR pays the debt down by fixing root causes. With all four
quarantine lists at zero active entries, no test is skipped, and the
production `save_plan` status-revert bug is closed.

## Validation

- `bun run build` + `bun run typecheck` + `bunx biome ci .` — clean.
- `bash scripts/check-mock-cleanup.sh` + `bash scripts/check-invariants.sh` — pass.
- `bun run scripts/check-tool-registration.ts` — pass (105 tools).
- All 21 previously-quarantined unit files + 11 integration files pass
  individually on a Windows host.
- Production bug #1: 3 previously-failing tests now pass; new regression test
  `tests/unit/plan/manager-projection-precedence.test.ts` covers both
  Scenario A and Scenario B directions.
- macOS-only failures cannot be reproduced on a Windows host; the realpath
  wraps and POSIX-portable grep are HIGH-confidence mechanical fixes. The
  merge_group `unit (macos-latest, N)` run is the authoritative gate.
